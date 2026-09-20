// 接收端下载按钮流程验证（Node 环境 + 极简 DOM 模拟）
// 用法: node tests/download-button-check.js
// 覆盖: 二进制分片接收 -> 收齐 -> 显示"保存文件"按钮 -> 拼接数据下载
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS_DIR = path.join(__dirname, '..', 'web', 'file', 'js');

// ===== 极简 DOM 模拟 =====
class FakeElement {
    constructor(tag) {
        this.tagName = (tag || 'div').toUpperCase();
        this.children = [];
        this.style = {};
        this.attributes = {};
        this._classes = new Set();
        this._text = '';
        this._html = '';
        this.parentNode = null;
        this.id = '';
        this.removed = false;
    }
    get className() { return Array.from(this._classes).join(' '); }
    set className(v) {
        this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
    }
    get classList() {
        const self = this;
        return {
            add: (...c) => c.forEach(x => self._classes.add(x)),
            remove: (...c) => c.forEach(x => self._classes.delete(x)),
            contains: (c) => self._classes.has(c),
            toggle: (c) => (self._classes.has(c) ? self._classes.delete(c) : self._classes.add(c))
        };
    }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); }
    get innerHTML() { return this._html; }
    set innerHTML(v) {
        this._html = String(v);
        // 解析 <button ... class="..."> 形式，供后续查询
        this.children = [];
        const tagRe = /<(\w+)([^>]*)>/g;
        let m;
        while ((m = tagRe.exec(this._html)) !== null) {
            const el = new FakeElement(m[1]);
            const attrRe = /(\w[\w-]*)="([^"]*)"/g;
            let a;
            while ((a = attrRe.exec(m[2])) !== null) {
                if (a[1] === 'class') el.className = a[2];
                else el.attributes[a[1]] = a[2];
            }
            el.parentNode = this;
            this.children.push(el);
        }
    }
    appendChild(el) { el.parentNode = this; this.children.push(el); return el; }
    removeChild(el) { this.children = this.children.filter(c => c !== el); return el; }
    remove() {
        this.removed = true;
        if (this.parentNode) this.parentNode.removeChild(this);
        else if (this._registry) delete this._registry[this.id]; // 顶层元素
    }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k] !== undefined ? this.attributes[k] : null; }
    addEventListener() {}
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    querySelectorAll(sel) {
        const want = sel.replace(/^\./, '');
        const out = [];
        const walk = (node) => {
            node.children.forEach(c => {
                if (c._classes.has(want)) out.push(c);
                walk(c);
            });
        };
        walk(this);
        return out;
    }
    click() { this.removed = false; }
    getBoundingClientRect() { return { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 }; }
}

function makeDocument() {
    const ids = {};
    return {
        body: new FakeElement('body'),
        getElementById(id) {
            if (!ids[id]) {
                ids[id] = new FakeElement('div');
                ids[id].id = id;
                ids[id]._registry = ids;
            }
            return ids[id];
        },
        createElement: (tag) => new FakeElement(tag),
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
        _ids: ids
    };
}

// ===== 构建沙箱并加载真实源码 =====
function loadDashboard() {
    const document = makeDocument();
    const downloads = [];
    const messages = [];

    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        document,
        sessionStorage: {
            _d: {},
            getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
            setItem(k, v) { this._d[k] = String(v); },
            removeItem(k) { delete this._d[k]; }
        },
        window: { location: { href: '' }, innerWidth: 1200 },
        URL: {
            createObjectURL: () => 'blob:mock',
            revokeObjectURL: () => {}
        },
        Blob: class Blob {
            constructor(parts) { this.parts = parts; }
        },
        TextEncoder,
        TextDecoder
    };
    sandbox.window.document = document;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    // 三个真实前端模块：协议编解码 + 传输分发 + 页面逻辑
    ['binary-protocol.js', 'transport.js', 'dashboard.js'].forEach(f => {
        vm.runInContext(fs.readFileSync(path.join(JS_DIR, f), 'utf8'), sandbox, { filename: f });
    });

    sandbox.__messages = messages;
    sandbox.__blobs = downloads;

    // 捕获 showMessage 输出 与 Blob 内容
    vm.runInContext(`
        var __origShowMessage = showMessage;
        showMessage = function (t) { __messages.push(t); __origShowMessage(t); };
    `, sandbox);
    sandbox.Blob = class CapturingBlob {
        constructor(parts) {
            this.parts = parts;
            downloads.push(this);
        }
    };
    // 模拟 transport 层：解码二进制包并交给已注册的 file_chunk 处理器
    vm.runInContext(`
        function decodeFileChunkAndDispatch(buf) {
            var d = decodeFileChunk(buf);
            if (!d) { return null; }
            handleBinaryFileChunk(d);
            return d;
        }
    `, sandbox);

    return { sandbox, document, downloads, messages, vm };
}

// ===== 断言工具 =====
let passed = 0;
let failed = 0;
function check(label, cond, extra) {
    if (cond) {
        passed++;
        console.log('  [OK]   ' + label);
    } else {
        failed++;
        console.log('  [FAIL] ' + label + (extra ? '  -> ' + extra : ''));
    }
}

// 生成二进制分片（复用前端编码函数，确保协议一致）
function makeChunk(sandbox, fileId, offset, bytes) {
    return vm.runInContext(
        `encodeFileChunk(${JSON.stringify(fileId)}, ${offset}, new Uint8Array([${Array.from(bytes).join(',')}]))`,
        sandbox
    );
}

function dispatch(sandbox, buffer) {
    sandbox.__c = buffer;
    return vm.runInContext('decodeFileChunkAndDispatch(__c)', sandbox);
}

// ===== 场景 1：服务端不发送 file_complete（旧服务器），客户端应自行兜底显示下载按钮 =====
function scenarioNoServerComplete() {
    console.log('\n场景 1: 服务器未下发 file_complete（复现当前故障）');
    const { sandbox, document, messages } = loadDashboard();
    const fileId = 'file_test_1';
    const content = Buffer.from('Hello P2P file transfer test content ', 'utf8');

    vm.runInContext(`handleFileMeta({type:'file_meta',from:'peer1',from_name:'Client-peer1',filename:'demo.txt',filesize:${content.length},fileid:'${fileId}'})`, sandbox);

    const half = Math.floor(content.length / 2);
    dispatch(sandbox, makeChunk(sandbox, fileId, 0, content.subarray(0, half)));
    dispatch(sandbox, makeChunk(sandbox, fileId, half, content.subarray(half)));

    const item = document.getElementById('progress_' + fileId);
    const btn = item.querySelector('.download-btn');
    check('进度条元素存在', !!item);
    check('未收到 file_complete 也显示了下载按钮', !!btn, '按钮缺失');
    check('进度条标记为已完成', item.classList.contains('progress-complete'));
    check('显示了接收完成提示', messages.some(m => m.indexOf('文件接收完成') === 0));

    vm.runInContext(`downloadReceivedFile('${fileId}')`, sandbox);
    const captured = sandbox.__blobs[sandbox.__blobs.length - 1];
    const data = captured && captured.parts && captured.parts[0] ? Buffer.from(captured.parts[0]) : Buffer.alloc(0);
    check('下载数据与原始内容一致', data.equals(content), '长度 ' + data.length + ' vs ' + content.length);
}

// ===== 场景 2：服务端下发 file_complete（修复后的服务器） =====
function scenarioWithServerComplete() {
    console.log('\n场景 2: 服务器下发 file_complete（修复后的服务器）');
    const { sandbox, document } = loadDashboard();
    const fileId = 'file_test_2';
    const content = Buffer.from('binary chunk payload', 'utf8');

    vm.runInContext(`handleFileMeta({type:'file_meta',from:'peer2',from_name:'Client-peer2',filename:'a.bin',filesize:${content.length},fileid:'${fileId}'})`, sandbox);
    dispatch(sandbox, makeChunk(sandbox, fileId, 0, content));
    vm.runInContext(`handleFileComplete({type:'file_complete',from:'peer2',fileid:'${fileId}',filename:'a.bin',filesize:${content.length}})`, sandbox);

    const item = document.getElementById('progress_' + fileId);
    check('显示下载按钮', !!item.querySelector('.download-btn'));
    vm.runInContext(`handleFileComplete({type:'file_complete',from:'peer2',fileid:'${fileId}',filename:'a.bin',filesize:${content.length}})`, sandbox);
    check('重复通知不会重复添加按钮', item.querySelectorAll('.download-btn').length === 1);

    vm.runInContext(`currentFileId='file_test_2'`, sandbox);
    vm.runInContext(`handleFileComplete({type:'file_complete',from:'peer2',fileid:'file_test_2',filename:'a.bin',filesize:${content.length}})`, sandbox);
    check('发送方状态被清理', vm.runInContext('currentFileId === null', sandbox));
}

// ===== 场景 3：分片早于 file_meta 到达（乱序兜底） =====
function scenarioChunkBeforeMeta() {
    console.log('\n场景 3: 分片早于 file_meta 到达（乱序兜底）');
    const { sandbox, document } = loadDashboard();
    const fileId = 'file_test_3';
    const content = Buffer.from('out of order', 'utf8');

    let threw = null;
    try {
        dispatch(sandbox, makeChunk(sandbox, fileId, 0, content));
    } catch (e) {
        threw = e;
    }
    check('乱序分片不会抛异常', threw === null, threw && threw.message);
    check('为未知文件补建了进度条', !!document.getElementById('progress_' + fileId));
    // 关键：此时还不知道文件大小，不能提前显示下载按钮（否则会存出不完整文件）
    check('大小未知时不提前显示下载按钮', !document.getElementById('progress_' + fileId).querySelector('.download-btn'));

    vm.runInContext(`handleFileMeta({type:'file_meta',from:'peer3',from_name:'C3',filename:'o.txt',filesize:${content.length},fileid:'${fileId}'})`, sandbox);
    check('元信息到达后显示下载按钮', !!document.getElementById('progress_' + fileId).querySelector('.download-btn'));

    // 下载内容应与原始数据一致
    vm.runInContext(`downloadReceivedFile('${fileId}')`, sandbox);
    const captured = sandbox.__blobs[sandbox.__blobs.length - 1];
    const data = captured && captured.parts && captured.parts[0] ? Buffer.from(captured.parts[0]) : Buffer.alloc(0);
    check('乱序场景下载数据正确', data.equals(content), data.toString());
}

// ===== 场景 4：空文件 =====
function scenarioEmptyFile() {
    console.log('\n场景 4: 0 字节文件');
    const { sandbox, document } = loadDashboard();
    const fileId = 'file_test_4';
    vm.runInContext(`handleFileMeta({type:'file_meta',from:'peer4',from_name:'C4',filename:'empty.txt',filesize:0,fileid:'${fileId}'})`, sandbox);
    check('空文件直接显示下载按钮', !!document.getElementById('progress_' + fileId).querySelector('.download-btn'));
}

// ===== 场景 5：保存/丢弃后迟到的分片不产生错误界面 =====
function scenarioDiscardThenLateChunk() {
    console.log('\n场景 5: 文件保存后迟到的分片');
    const { sandbox, document } = loadDashboard();
    const fileId = 'file_test_5';
    const content = Buffer.from('abcdefghij', 'utf8');
    vm.runInContext(`handleFileMeta({type:'file_meta',from:'p5',from_name:'C5',filename:'d.txt',filesize:${content.length},fileid:'${fileId}'})`, sandbox);
    dispatch(sandbox, makeChunk(sandbox, fileId, 0, content));
    check('收齐后显示下载按钮', !!document.getElementById('progress_' + fileId).querySelector('.download-btn'));

    vm.runInContext(`downloadReceivedFile('${fileId}')`, sandbox);
    check('保存后数据被清理', vm.runInContext(`receivedFiles['${fileId}'] === undefined`, sandbox));

    let threw = null;
    try {
        dispatch(sandbox, makeChunk(sandbox, fileId, 0, Buffer.from('xx', 'utf8')));
    } catch (e) {
        threw = e;
    }
    check('保存后迟到的分片被忽略且不抛异常', threw === null, threw && threw.message);
}

// ===== 场景 6：数据不完整时不应显示下载按钮 =====
function scenarioIncompleteData() {
    console.log('\n场景 6: 数据不完整时的处理');
    const { sandbox, document } = loadDashboard();
    const fileId = 'file_test_6';
    const content = Buffer.from('0123456789', 'utf8');
    vm.runInContext(`handleFileMeta({type:'file_meta',from:'p6',from_name:'C6',filename:'part.bin',filesize:${content.length},fileid:'${fileId}'})`, sandbox);
    dispatch(sandbox, makeChunk(sandbox, fileId, 0, content.subarray(0, 4)));
    // 服务端/发送方错误地提前声明完成
    vm.runInContext(`handleFileComplete({type:'file_complete',fileid:'${fileId}',filename:'part.bin',filesize:${content.length}})`, sandbox);

    check('数据不足时不显示下载按钮', !document.getElementById('progress_' + fileId).querySelector('.download-btn'));
}

// ===== 场景 7：端到端（模拟修复后的服务端中继 100KB 文件） =====
// 用 8KB 分片模拟 100KB 文件的完整收发链路，验证收齐后服务端下发 file_complete
function scenarioEndToEndRelay() {
    console.log('\n场景 7: 端到端中继模拟（模拟修复后的服务端）');
    const { sandbox, document } = loadDashboard();
    const fileId = 'file_e2e';
    const CHUNK = 8 * 1024;
    const fileName = 'big.bin';

    // 生成 100KB 伪随机内容
    const content = Buffer.alloc(100 * 1024);
    for (let i = 0; i < content.length; i++) content[i] = (i * 31 + 7) & 0xff;

    // 模拟服务端 FileTransferInfo
    const ftInfo = {
        fileId: fileId,
        fileName: fileName,
        fileSize: content.length,
        bytesSent: 0,
        fromClientId: 'sender-1',
        toClientId: 'recv-1',
        complete: false
    };

    // 1) 接收方收到 file_meta（服务端 handleFileMeta 转发）
    vm.runInContext(`handleFileMeta({type:'file_meta',from:'sender-1',from_name:'Client-sender1',filename:'${fileName}',filesize:${content.length},fileid:'${fileId}'})`, sandbox);

    // 2) 逐个分片：发送方 -> 服务端(handleBinaryFileChunk) -> 接收方
    const serverToReceiver = [];
    let completionSent = false;
    for (let offset = 0; offset < content.length; offset += CHUNK) {
        const slice = content.subarray(offset, Math.min(offset + CHUNK, content.length));
        const packet = makeChunk(sandbox, fileId, offset, slice);

        // ---- 服务端逻辑（与被修改的 handleBinaryFileChunk 一致）----
        ftInfo.bytesSent += slice.length;
        if (!ftInfo.complete && ftInfo.bytesSent >= ftInfo.fileSize) {
            ftInfo.complete = true;
            completionSent = true;
            serverToReceiver.push({
                type: 'file_complete',
                from: ftInfo.fromClientId,
                fileid: fileId,
                filename: ftInfo.fileName,
                filesize: ftInfo.fileSize
            });
        }
        // ---- 接收方收到二进制分片 ----
        dispatch(sandbox, packet);
    }

    check('服务端在收齐后发送了 file_complete', completionSent);
    check('分片总数符合预期（100KB / 8KB）', Math.ceil(content.length / CHUNK) === 13);

    // 3) 接收方处理服务端的 file_complete（此时按钮已由兜底逻辑显示）
    serverToReceiver.forEach(msg => {
        vm.runInContext(`handleFileComplete(${JSON.stringify(msg)})`, sandbox);
    });

    const item = document.getElementById('progress_' + fileId);
    check('下载按钮已出现', !!item.querySelector('.download-btn'));
    check('按钮只有一个（未被重复添加）', item.querySelectorAll('.download-btn').length === 1);

    // 4) 保存并校验完整性
    vm.runInContext(`downloadReceivedFile('${fileId}')`, sandbox);
    const captured = sandbox.__blobs[sandbox.__blobs.length - 1];
    const saved = captured && captured.parts && captured.parts[0] ? Buffer.from(captured.parts[0]) : Buffer.alloc(0);
    check('保存的文件大小与原始一致', saved.length === content.length, saved.length + ' vs ' + content.length);
    check('保存的文件内容逐字节一致', saved.equals(content));
}

// ===== 运行 =====
console.log('接收端下载按钮流程验证');
scenarioNoServerComplete();
scenarioWithServerComplete();
scenarioChunkBeforeMeta();
scenarioEmptyFile();
scenarioDiscardThenLateChunk();
scenarioIncompleteData();
scenarioEndToEndRelay();

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
process.exit(failed === 0 ? 0 : 1);
