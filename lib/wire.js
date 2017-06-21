'use strict';

var stream = require('stream');
var crypto = require('crypto');
var util = require('util');

var BitField = require('bitfield');
var bencode = require('bencode');

var utils = require('./utils');

var BT_RESERVED = new Buffer([0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x01]);
var BT_PROTOCOL = new Buffer('BitTorrent protocol');
var PIECE_LENGTH = Math.pow(2, 14);//每片大小
var MAX_METADATA_SIZE = 10000000;//最大10m
var BITFIELD_GROW = 1000;//最大1000片?
var EXT_HANDSHAKE_ID = 0;
var BT_MSG_ID = 20;

//一个wire代表一个peer(infohash资源)的各种处理包装
var Wire = function(infohash) {
    stream.Duplex.call(this);

    this._bitfield = new BitField(0, { grow: BITFIELD_GROW });
    this._infohash = infohash;

    this._buffer = [];
    this._bufferSize = 0;

    this._next = null;
    this._nextSize = 0;

    this._metadata = null;
    this._metadataSize = null;
    this._numPieces = 0;
    this._ut_metadata = null;

    this._onHandshake();
}

util.inherits(Wire, stream.Duplex);

/**4,握手后数据消息处理入口,注册后由流式_write驱动 */
Wire.prototype._onMessageLength = function (buffer) {
    if (buffer.length >= 4) {
        var length = buffer.readUInt32BE(0);
        if (length > 0) {
            this._register(length, this._onMessage)
        }
    }
};

Wire.prototype._onMessage = function (buffer) {
    this._register(4, this._onMessageLength)
    if (buffer[0] == BT_MSG_ID) {
        this._onExtended(buffer.readUInt8(1), buffer.slice(2));
    }
};

Wire.prototype._onExtended = function(ext, buf) {
    if (ext === 0) {
        try {
            this._onExtHandshake(bencode.decode(buf));
        }
        catch (err) {
            this._fail();
        }
    }
    else {
        this._onPiece(buf);
    }
};

Wire.prototype._register = function (size, next) {
    this._nextSize = size;
    this._next = next;
};

Wire.prototype.end = function() {
    stream.Duplex.prototype.end.apply(this, arguments);
};

/**1.0b, 标准节点间握手协议响应, 递进函数处理方法 */
Wire.prototype._onHandshake = function() {
    this._register(1, function(buffer) {
        if (buffer.length == 0) {
            this.end();
            return this._fail();
        }
        var pstrlen = buffer.readUInt8(0);
        this._register(pstrlen + 48, function(handshake) {
            var protocol = handshake.slice(0, pstrlen);
            if (protocol.toString() !== BT_PROTOCOL.toString()) {
                this.end();
                this._fail();
                return;
            }
            handshake = handshake.slice(pstrlen);
            if ( !!(handshake[5] & 0x10) ) {
                this._register(4, this._onMessageLength);//注册握手后消息处理函数,也由流式_write驱动
                this._sendExtHandshake();
            }
            else {
                this._fail();
            }
        }.bind(this));
    }.bind(this));
};

/**1.2,扩展握手的响应,进行 真正的 种子信息请求 */
Wire.prototype._onExtHandshake = function(extHandshake) {
    if (!extHandshake.metadata_size || !extHandshake.m.ut_metadata
            || extHandshake.metadata_size > MAX_METADATA_SIZE) {
        this._fail();
        return;
    }

    this._metadataSize = extHandshake.metadata_size;
    this._numPieces = Math.ceil(this._metadataSize / PIECE_LENGTH);
    this._ut_metadata = extHandshake.m.ut_metadata;//类似一个通信 token,请求piece时传回即可

    this._requestPieces();
}

Wire.prototype._requestPieces = function() {
    this._metadata = new Buffer(this._metadataSize);
    for (var piece = 0; piece < this._numPieces; piece++) {
        this._requestPiece(piece);
    }
};

/**1.3 请求种子的每一片信息 */
Wire.prototype._requestPiece = function(piece) {
    var msg = Buffer.concat([
        new Buffer([BT_MSG_ID]),
        new Buffer([this._ut_metadata]),
        bencode.encode({msg_type: 0, piece: piece})
    ]);
    this._sendMessage(msg);
};

Wire.prototype._sendPacket = function(packet) {
    this.push(packet);
};

Wire.prototype._sendMessage = function(msg) {
    var buf = new Buffer(4);
    buf.writeUInt32BE(msg.length, 0);
    this._sendPacket(Buffer.concat([buf, msg]));
};

/**1.0,发起握手的程序入口 */
Wire.prototype.sendHandshake = function() {
    var peerID = utils.randomID();
    var packet = Buffer.concat([
        new Buffer([BT_PROTOCOL.length]),
        BT_PROTOCOL, BT_RESERVED, this._infohash,  peerID
    ]);
    this._sendPacket(packet);
};

/**1.1, 发起扩展握手请求,格式参考bep_010,bep_009 */
Wire.prototype._sendExtHandshake = function() {
    var msg = Buffer.concat([
        new Buffer([BT_MSG_ID]),
        new Buffer([EXT_HANDSHAKE_ID]),
        bencode.encode({m: {ut_metadata: 1}})
    ]);
    this._sendMessage(msg);
};

/**1.4 每一片响应 */
Wire.prototype._onPiece = function(piece) {
    var dict, trailer;
    try {
        var str = piece.toString();
        var trailerIndex = str.indexOf('ee') + 2;
        dict = bencode.decode(str.substring(0, trailerIndex));
        trailer = piece.slice(trailerIndex);
    }
    catch (err) {
        this._fail();
        return;
    }
    if (dict.msg_type != 1) {
        this._fail();
        return;
    }
    if (trailer.length > PIECE_LENGTH) {
        this._fail();
        return;
    }
    trailer.copy(this._metadata, dict.piece * PIECE_LENGTH);
    this._bitfield.set(dict.piece);
    this._checkDone();
};

Wire.prototype._checkDone = function () {
    var done = true;
    for (var piece = 0; piece < this._numPieces; piece++) {
        if (!this._bitfield.get(piece)) {
            done = false;
            break;
        }
    }
    if (!done) {
        return
    }
    this._onDone(this._metadata);
};

Wire.prototype._onDone = function(metadata) {
    try {
        var info = bencode.decode(metadata).info;
        if (info) {
            metadata = bencode.encode(info);
        }
    }
    catch (err) {
        this._fail();
        return;
    }
    var infohash = crypto.createHash('sha1').update(metadata).digest('hex');
    if (this._infohash.toString('hex') != infohash ) {
        this._fail();
        return false;
    }
    this.emit('metadata', {info: bencode.decode(metadata)}, this._infohash);
};

Wire.prototype._fail = function() {
    this.emit('fail');
};

/**
 * 0,远程响应的程序入口: 流式写法, 数据处理程序在_onHandshake中注册 
 * TODO: 仔细理解下面这个函数!!!?????????????????流程控制
 * 逐语句!!!!
*/
Wire.prototype._write = function (buf, encoding, next) {
    this._bufferSize += buf.length;
    this._buffer.push(buf);

    //这个循环和上面的嵌套注册对应
    while (this._bufferSize >= this._nextSize) {
        var buffer = Buffer.concat(this._buffer);
        this._bufferSize -= this._nextSize;
        this._buffer = this._bufferSize                 //_buffer重置成buffer的剩余部分
            ? [buffer.slice(this._nextSize)]
            : [];
        this._next(buffer.slice(0, this._nextSize)); //处理_buffer开头制定部分的报文
    }

    next(null);
}

//空实现?不输出任何东西给socket么?
Wire.prototype._read = function() {
    // do nothing
    //说明: 是在_sendPacket中进行的push,这样也可以?---可以的
};

module.exports = Wire;
