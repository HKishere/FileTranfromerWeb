// 二进制传输协议编解码模块
// 仅用于 file_chunk 大数据传输（file_meta / file_complete 仍走 JSON 文本以保证路由信息）
//
// 协议格式：
//   file_chunk: [1B type=0x02][2B fileIdLen][N bytes fileId UTF-8][8B offset][4B dataLen][原始二进制数据]
//
// 服务端收到后根据 fileId 查找目标客户端，透传整个二进制包，无需编解码。

const BINARY_TYPE = {
    FILE_CHUNK: 2
};

// ===== 编码函数 =====

// 编码 file_chunk 消息（含字符串 fileId，供服务端路由用）
function encodeFileChunk(fileId, offset, data) {
    const fileIdBytes = new TextEncoder().encode(fileId);
    const fileIdLen = fileIdBytes.length;
    const dataLen = data.byteLength || data.length;

    // header: 1B type + 2B fileIdLen + fileId + 8B offset + 4B dataLen
    const headerSize = 1 + 2 + fileIdLen + 8 + 4;
    const buf = new ArrayBuffer(headerSize + dataLen);
    const view = new DataView(buf);
    let pos = 0;

    view.setUint8(pos, BINARY_TYPE.FILE_CHUNK); pos += 1;
    view.setUint16(pos, fileIdLen, true); pos += 2;

    const bytes = new Uint8Array(buf);
    bytes.set(fileIdBytes, pos); pos += fileIdLen;

    view.setBigUint64(pos, BigInt(offset), true); pos += 8;
    view.setUint32(pos, dataLen, true); pos += 4;

    if (data instanceof Uint8Array) {
        bytes.set(data, pos);
    } else if (data instanceof ArrayBuffer) {
        bytes.set(new Uint8Array(data), pos);
    } else {
        bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), pos);
    }

    return buf;
}

// ===== 解码函数 =====

// 解码 file_chunk 二进制消息，返回 { type, fileId, offset, dataLen, data }
// 如果 buffer 不是合法的 file_chunk 格式则返回 null
function decodeFileChunk(buffer) {
    if (!buffer || buffer.byteLength < 1 + 2 + 1 + 8 + 4) return null;

    const view = new DataView(buffer);
    const type = view.getUint8(0);
    if (type !== BINARY_TYPE.FILE_CHUNK) return null;

    let pos = 1;
    const fileIdLen = view.getUint16(pos, true); pos += 2;

    if (buffer.byteLength < 1 + 2 + fileIdLen + 8 + 4) return null;
    const fileIdBytes = new Uint8Array(buffer, pos, fileIdLen);
    const fileId = new TextDecoder().decode(fileIdBytes);
    pos += fileIdLen;

    const offset = view.getBigUint64(pos, true); pos += 8;
    const dataLen = view.getUint32(pos, true); pos += 4;

    if (buffer.byteLength < pos + dataLen) return null;
    const data = new Uint8Array(buffer.slice(pos, pos + dataLen));

    return {
        type: BINARY_TYPE.FILE_CHUNK,
        fileId,
        offset: Number(offset),
        dataLen,
        data
    };
}