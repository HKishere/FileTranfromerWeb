// 存储接收中的文件数据
let receivedFiles = {};  // fileid -> { chunks: [], filename, filesize, receivedSize }
let receivedFileChunks = {}; // fileid -> [{offset, data}]

// 主页面 JavaScript

let selectedClientId = null;
let selectedClientName = null;
let selectedFile = null;
let currentFileId = null;
let chunkSize = 64 * 1024; // 64KB 每块

// 记录每个客户端的 P2P 连接状态
let p2pStatus = {};  // clientId -> boolean

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', function() {
    // 检查是否已认证（JWT token 存在即表示已认证）
    const token = sessionStorage.getItem('auth_token');
    if (!token) {
        window.location.href = 'index.html';
        return;
    }
    
    // 显示自己的 ID
    const clientId = sessionStorage.getItem('client_id');
    if (clientId) {
        document.getElementById('myId').textContent = 'ID: ' + clientId;
    }
    
    // 初始化传输层
    if (typeof initTransport === 'function') {
        initTransport();
    }
    
    // 初始化 WebSocket 连接
    if (typeof initWebSocket === 'function') {
        initWebSocket();
    }
    
    // 注册文本消息处理器（通过 transport 层）
    // file_meta、file_complete 走 JSON 文本（保留 to 路由字段）
    transportOnMessage('auth_result', handleAuthResult);
    transportOnMessage('client_list', handleClientList);
    transportOnMessage('text', handleTextMessage);
    transportOnMessage('file_meta', handleFileMeta);
    transportOnMessage('file_progress', handleFileProgress);
    transportOnMessage('file_complete', handleFileComplete);
    transportOnMessage('error', handleError);
    
    // 注册二进制消息处理器（仅 file_chunk 走二进制直传，无 Base64）
    transportOnBinaryMessage(BINARY_TYPE.FILE_CHUNK, handleBinaryFileChunk);
    
    // 注册传输模式变更回调（更新 UI）
    onTransportModeChange(function(mode) {
        const modeIndicator = document.getElementById('transportMode');
        if (modeIndicator) {
            if (mode === 'webrtc') {
                modeIndicator.textContent = 'P2P 直连';
                modeIndicator.className = 'mode-badge mode-p2p';
            } else {
                modeIndicator.textContent = 'WebSocket 中继';
                modeIndicator.className = 'mode-badge mode-relay';
            }
        }
    });
    
    // 注册 P2P 状态变更回调
    window.onP2PStatusChange = function(clientId, connected) {
        p2pStatus[clientId] = connected;
        // 更新客户端列表中的 P2P 标识
        updateP2PBadge(clientId, connected);
    };
    
    // 点击页面其他地方关闭浮动菜单
    document.addEventListener('click', function(event) {
        const menu = document.getElementById('clientMenu');
        if (menu && !menu.contains(event.target)) {
            // 检查点击的不是客户端项
            if (!event.target.closest('.client-item')) {
                closeClientMenu();
            }
        }
    });
});

// 更新客户端的 P2P 标识
function updateP2PBadge(clientId, connected) {
    const clientEl = document.querySelector('.client-item[data-client-id="' + clientId + '"]');
    if (clientEl) {
        const badge = clientEl.querySelector('.p2p-badge');
        if (badge) {
            if (connected) {
                badge.style.display = 'inline';
            } else {
                badge.style.display = 'none';
            }
        }
    }
}

// ===== 鉴权结果处理 =====
function handleAuthResult(data) {
    if (data.success) {
        sessionStorage.setItem('client_id', data.client_id);
        document.getElementById('myId').textContent = 'ID: ' + data.client_id;
    } else {
        // 鉴权失败，返回登录页
        sessionStorage.removeItem('auth_token');
        sessionStorage.removeItem('client_id');
        window.location.href = 'index.html';
    }
}

// ===== 客户端列表 =====
function handleClientList(data) {
    const clientList = document.getElementById('clientList');
    const clientCount = document.getElementById('clientCount');
    const clients = data.clients || [];
    
    clientCount.textContent = clients.length;
    
    if (clients.length === 0) {
        clientList.innerHTML = '<div class="empty-hint">暂无在线客户端</div>';
        return;
    }
    
    let html = '';
    clients.forEach(function(client) {
        // 不显示自己
        if (client.id === sessionStorage.getItem('client_id')) return;
        
        const isSelected = client.id === selectedClientId;
        const initial = client.name.charAt(0).toUpperCase();
        const hasP2P = p2pStatus[client.id] === true;
        
        html += '<div class="client-item' + (isSelected ? ' selected' : '') + '" data-client-id="' + client.id + '" data-client-name="' + escapeAttr(client.name) + '" onclick="showClientMenu(event, this)">';
        html += '    <div class="client-avatar">' + initial + '</div>';
        html += '    <div class="client-info">';
        html += '        <div class="client-name">' + escapeHtml(client.name) + '</div>';
        html += '        <span class="p2p-badge"' + (hasP2P ? '' : ' style="display:none"') + '>P2P</span>';
        html += '    </div>';
        html += '    <div class="client-status-dot"></div>';
        html += '</div>';
    });
    
    clientList.innerHTML = html;
    
    // 如果选中的客户端已断开，取消选择
    if (selectedClientId) {
        const stillExists = clients.some(function(c) { return c.id === selectedClientId; });
        if (!stillExists) {
            deselectClient();
        }
    }
}

// 显示客户端浮动菜单
function showClientMenu(event, element) {
    event.stopPropagation();
    
    // 从元素属性获取客户端信息
    const clientId = element.getAttribute('data-client-id');
    const clientName = element.getAttribute('data-client-name');
    
    if (!clientId) return;
    
    // 先关闭之前的菜单
    closeClientMenu();
    
    selectedClientId = clientId;
    selectedClientName = clientName;
    
    // 通知 transport 层选择目标（但不发起连接）
    if (typeof selectTarget === 'function') {
        selectTarget(clientId);
    }
    
    // 更新客户端选中状态
    document.querySelectorAll('.client-item').forEach(function(el) {
        el.classList.remove('selected');
    });
    if (element) {
        element.classList.add('selected');
    }
    
    // 显示目标信息
    document.getElementById('targetInfo').style.display = 'block';
    document.getElementById('targetName').textContent = clientName;
    
    // 启用按钮
    document.getElementById('sendTextBtn').disabled = false;
    document.getElementById('sendFileBtn').disabled = !selectedFile;
    
    // 获取点击位置
    const rect = element.getBoundingClientRect();
    const menu = document.getElementById('clientMenu');
    
    // 设置菜单位置 - 在客户端项右侧
    const menuLeft = rect.right + 8;
    const menuTop = rect.top;
    
    // 确保菜单不超出右侧边界
    const menuWidth = 160;
    const viewportWidth = window.innerWidth;
    const finalLeft = (menuLeft + menuWidth > viewportWidth) ? rect.left - menuWidth - 8 : menuLeft;
    
    menu.style.left = finalLeft + 'px';
    menu.style.top = menuTop + 'px';
    menu.style.display = 'block';
    
    // 设置 P2P 按钮状态和标签
    const p2pBtn = document.getElementById('p2pConnectBtn');
    const hasP2P = p2pStatus[clientId] === true;
    
    if (hasP2P) {
        p2pBtn.textContent = '✅ 已 P2P 连接';
        p2pBtn.disabled = true;
    } else {
        p2pBtn.textContent = '🔗 P2P 连接';
        p2pBtn.disabled = false;
    }
    
    // 存储当前选中的客户端 ID 在菜单上
    menu.setAttribute('data-client-id', clientId);
}

// 关闭客户端浮动菜单
function closeClientMenu() {
    const menu = document.getElementById('clientMenu');
    if (menu) {
        menu.style.display = 'none';
    }
}

// 手动发起 P2P 连接
function connectP2P() {
    const menu = document.getElementById('clientMenu');
    const clientId = menu.getAttribute('data-client-id');
    
    if (!clientId) return;
    
    const p2pBtn = document.getElementById('p2pConnectBtn');
    p2pBtn.textContent = '⏳ 连接中...';
    p2pBtn.disabled = true;
    
    // 通过 transport 层发起 P2P 连接
    if (typeof manualConnectP2P === 'function') {
        const success = manualConnectP2P(clientId);
        if (!success) {
            p2pBtn.textContent = '❌ 连接失败';
            setTimeout(function() {
                p2pBtn.textContent = '🔗 P2P 连接';
                p2pBtn.disabled = false;
            }, 2000);
        } else {
            // 等待连接成功回调，如果 10 秒没成功则重置按钮
            setTimeout(function() {
                const hasP2P = p2pStatus[clientId] === true;
                if (!hasP2P) {
                    p2pBtn.textContent = '🔗 P2P 连接';
                    p2pBtn.disabled = false;
                }
            }, 10000);
        }
    } else {
        p2pBtn.textContent = '❌ 不支持 P2P';
        setTimeout(function() {
            closeClientMenu();
        }, 1500);
    }
}

function selectClient(clientId, clientName) {
    // 这个方法保留但不使用，由 showClientMenu 替代
}

function deselectClient() {
    selectedClientId = null;
    selectedClientName = null;
    
    // 通知 transport 层取消选择
    if (typeof deselectTarget === 'function') {
        deselectTarget();
    }
    
    document.querySelectorAll('.client-item').forEach(function(el) {
        el.classList.remove('selected');
    });
    
    document.getElementById('targetInfo').style.display = 'none';
    document.getElementById('sendTextBtn').disabled = true;
    document.getElementById('sendFileBtn').disabled = true;
    
    closeClientMenu();
}

// ===== 文本发送 =====
function updateTextCount() {
    const textInput = document.getElementById('textInput');
    const textCount = document.getElementById('textCount');
    const len = textInput.value.length;
    textCount.textContent = len + ' / 40860';
    
    if (len > 40860) {
        textCount.style.color = '#e74c3c';
    } else {
        textCount.style.color = '#999';
    }
}

function sendText() {
    if (!selectedClientId) {
        showMessage('请先选择一个目标客户端');
        return;
    }
    
    const textInput = document.getElementById('textInput');
    const content = textInput.value.trim();
    
    if (!content) {
        showMessage('请输入要发送的文本');
        return;
    }
    
    if (content.length > 40860) {
        showMessage('文本过长，最大支持 40860 字节');
        return;
    }
    
    // 通过 transport 层发送（会优先使用 WebRTC P2P）
    const success = transportSend({
        type: 'text',
        to: selectedClientId,
        content: content
    });
    
    if (success) {
        textInput.value = '';
        updateTextCount();
        showMessage('文本已发送');
    } else {
        showMessage('发送失败，请检查连接');
    }
}

// ===== 文件处理 =====
function handleDragOver(event) {
    event.preventDefault();
    event.stopPropagation();
    document.getElementById('dropZone').classList.add('dragover');
}

function handleDragLeave(event) {
    event.preventDefault();
    event.stopPropagation();
    document.getElementById('dropZone').classList.remove('dragover');
}

function handleDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    document.getElementById('dropZone').classList.remove('dragover');
    
    const files = event.dataTransfer.files;
    if (files.length > 0) {
        selectFile(files[0]);
    }
}

function handleFileSelect(event) {
    const files = event.target.files;
    if (files.length > 0) {
        selectFile(files[0]);
    }
}

function selectFile(file) {
    selectedFile = file;
    
    // 显示文件信息
    document.getElementById('fileInfo').style.display = 'block';
    document.getElementById('selectedFileName').textContent = file.name;
    document.getElementById('selectedFileSize').textContent = formatFileSize(file.size);
    document.getElementById('fileName').textContent = file.name;
    
    // 启用发送按钮
    if (selectedClientId) {
        document.getElementById('sendFileBtn').disabled = false;
    }
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

// ===== 文件发送（二进制协议版） =====
function sendFile() {
    if (!selectedClientId) {
        showMessage('请先选择一个目标客户端');
        return;
    }
    
    if (!selectedFile) {
        showMessage('请先选择要发送的文件');
        return;
    }
    
    // 生成文件 ID
    currentFileId = generateFileId();
    
    // 显示进度区域
    document.getElementById('progressSection').style.display = 'block';
    
    // 添加进度条
    addProgressItem(currentFileId, selectedFile.name, selectedFile.size);
    
    // file_meta 走 JSON 文本（包含 to 路由字段，服务端需要用来转发）
    transportSend({
        type: 'file_meta',
        to: selectedClientId,
        filename: selectedFile.name,
        filesize: selectedFile.size,
        fileid: currentFileId
    });
    
    // 开始发送文件数据
    setTimeout(function() {
        startFileTransfer(currentFileId);
    }, 10);
    
    // 禁用发送按钮
    document.getElementById('sendFileBtn').disabled = true;
}

function generateFileId() {
    return 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// ===== 文件分块发送（二进制直传，无 Base64 编码，无延时） =====
function startFileTransfer(fileId) {
    const reader = new FileReader();
    let offset = 0;
    const file = selectedFile;
    const startTime = Date.now();
    
    reader.onload = function(e) {
        const arrayBuffer = e.target.result;
        const bytes = new Uint8Array(arrayBuffer);
        
        // 直接二进制编码发送（无 Base64，无 JSON 包裹）
        const packet = encodeFileChunk(fileId, offset, bytes);
        transportSendBinary(packet);
        
        // 更新发送进度
        const sent = offset + bytes.length;
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? formatFileSize(sent / elapsed) + '/s' : '0 B/s';
        updateProgress(fileId, sent, file.size, speed);
        
        offset += bytes.length;
        
        if (offset < file.size) {
            // 立即读取下一块（无 setTimeout 延迟）
            readNextChunk(file, offset, fileId, startTime);
        } else {
            // 文件发送完成，file_complete 走 JSON 文本
            console.log('文件发送完成: ' + file.name + ' (' + formatFileSize(file.size) + ')');
            transportSend({
                type: 'file_complete',
                to: selectedClientId,
                fileid: fileId,
                filename: file.name,
                filesize: file.size
            });
            showMessage('文件发送完成: ' + file.name);
            removeProgress(fileId);
        }
    };
    
    reader.onerror = function() {
        showMessage('读取文件失败');
    };
    
    readNextChunk(file, 0, fileId, startTime);
}

function readNextChunk(file, offset, fileId, startTime) {
    const chunk = file.slice(offset, offset + chunkSize);
    const reader = new FileReader();
    
    reader.onload = function(e) {
        const arrayBuffer = e.target.result;
        const bytes = new Uint8Array(arrayBuffer);
        
        // 直接二进制编码发送（无 Base64）
        const packet = encodeFileChunk(fileId, offset, bytes);
        transportSendBinary(packet);
        
        const newOffset = offset + bytes.length;
        
        // 更新发送进度
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? formatFileSize(newOffset / elapsed) + '/s' : '0 B/s';
        updateProgress(fileId, newOffset, file.size, speed);
        
        if (newOffset < file.size) {
            // 无延迟，立即发送下一块
            readNextChunk(file, newOffset, fileId, startTime);
        } else {
            // 文件发送完成，file_complete 走 JSON 文本
            console.log('文件发送完成: ' + file.name + ' (' + formatFileSize(file.size) + ')');
            transportSend({
                type: 'file_complete',
                to: selectedClientId,
                fileid: fileId,
                filename: file.name,
                filesize: file.size
            });
            showMessage('文件发送完成: ' + file.name);
            removeProgress(fileId);
        }
    };
    
    reader.readAsArrayBuffer(chunk);
}

// ===== 进度条管理 =====
function addProgressItem(fileId, fileName, fileSize) {
    const progressList = document.getElementById('progressList');
    
    const item = document.createElement('div');
    item.className = 'progress-item';
    item.id = 'progress_' + fileId;
    item.innerHTML = 
        '<div class="progress-header">' +
        '    <span class="progress-filename">' + fileName + '</span>' +
        '    <span class="progress-speed" id="speed_' + fileId + '">0 B/s</span>' +
        '</div>' +
        '<div class="progress-bar-container">' +
        '    <div class="progress-bar" id="bar_' + fileId + '" style="width: 0%"></div>' +
        '</div>' +
        '<div class="progress-text" id="text_' + fileId + '">0 / ' + formatFileSize(fileSize) + '</div>';
    
    progressList.appendChild(item);
}

function updateProgress(fileId, sent, total, speed) {
    const percent = Math.min(100, (sent / total) * 100);
    
    const bar = document.getElementById('bar_' + fileId);
    const text = document.getElementById('text_' + fileId);
    const speedEl = document.getElementById('speed_' + fileId);
    
    if (bar) bar.style.width = percent + '%';
    if (text) text.textContent = formatFileSize(sent) + ' / ' + formatFileSize(total);
    if (speedEl) speedEl.textContent = speed;
}

function removeProgress(fileId) {
    const item = document.getElementById('progress_' + fileId);
    if (item) {
        item.style.opacity = '0.5';
        setTimeout(function() {
            item.remove();
        }, 2000);
    }
}

// ===== 消息处理 =====
function handleTextMessage(data) {
    const messageList = document.getElementById('messageList');
    document.getElementById('messageSection').style.display = 'block';
    
    const item = document.createElement('div');
    item.className = 'message-item';
    item.innerHTML = 
        '<div class="message-from">来自 ' + (data.from_name || data.from) + ':</div>' +
        '<div class="message-content">' + escapeHtml(data.content) + '</div>';
    
    messageList.appendChild(item);
    messageList.scrollTop = messageList.scrollHeight;
}

// JSON 文本方式接收 file_meta（保留原有逻辑，包含 from 路由信息）
function handleFileMeta(data) {
    console.log('收到来自 ' + (data.from_name || data.from) + ' 的文件: ' + data.filename + ' (' + formatFileSize(data.filesize) + ')');
    showMessage('收到来自 ' + (data.from_name || data.from) + ' 的文件: ' + data.filename + ' (' + formatFileSize(data.filesize) + ')');
    document.getElementById('progressSection').style.display = 'block';
    
    // 初始化接收文件存储
    receivedFiles[data.fileid] = {
        filename: data.filename,
        filesize: data.filesize,
        chunks: [],
        receivedSize: 0
    };
    receivedFileChunks[data.fileid] = [];
    
    addProgressItem(data.fileid, data.filename, data.filesize);
}

// 二进制方式接收 file_chunk（无 Base64 解码，直接存储 Uint8Array）
function handleBinaryFileChunk(decoded) {
    // 存储收到的数据块（data 已经是 Uint8Array，不需要 Base64 解码）
    if (receivedFileChunks[decoded.fileId]) {
        receivedFileChunks[decoded.fileId].push({ offset: decoded.offset, data: decoded.data });
        receivedFiles[decoded.fileId].receivedSize += decoded.dataLen;
        
        // 更新进度
        const fileInfo = receivedFiles[decoded.fileId];
        if (fileInfo && fileInfo.filesize > 0) {
            updateProgress(decoded.fileId, decoded.offset + decoded.dataLen, fileInfo.filesize, '');
        }
    }
}

function handleFileProgress(data) {
    updateProgress(data.fileid, data.sent, data.total, data.speed);
}

// JSON 文本方式接收 file_complete
function handleFileComplete(data) {
    console.log('文件接收完成: ' + data.filename + ' (' + formatFileSize(data.filesize || 0) + ')');
    // 文件接收完成，提示用户保存
    const fileInfo = receivedFiles[data.fileid];
    if (fileInfo) {
        showMessage('文件接收完成: ' + data.filename + ' (' + formatFileSize(fileInfo.filesize) + ')');
        
        // 显示下载按钮
        showDownloadButton(data.fileid, fileInfo.filename, fileInfo.filesize);
    }
    
    //removeProgress(data.fileid);
    
    if (data.fileid === currentFileId) {
        selectedFile = null;
        currentFileId = null;
        document.getElementById('fileInfo').style.display = 'none';
        document.getElementById('fileName').textContent = '';
        document.getElementById('sendFileBtn').disabled = true;
    }
}

// 显示下载按钮
function showDownloadButton(fileId, filename, filesize) {
    const item = document.getElementById('progress_' + fileId);
    
    if (!item) return;
    
    // 添加下载按钮
    const downloadDiv = document.createElement('div');
    downloadDiv.className = 'download-action';
    downloadDiv.innerHTML = 
        '<button class="download-btn" onclick="downloadReceivedFile(\'' + fileId + '\')">💾 保存文件</button>' +
        '<button class="discard-btn" onclick="discardReceivedFile(\'' + fileId + '\')">🗑️ 丢弃</button>';
    item.appendChild(downloadDiv);
}

// 下载接收到的文件（二进制版 - 直接拼接 Uint8Array，无 Base64 解码）
function downloadReceivedFile(fileId) {
    const chunks = receivedFileChunks[fileId];
    const fileInfo = receivedFiles[fileId];
    
    if (!chunks || chunks.length === 0 || !fileInfo) {
        showMessage('错误: 文件数据不存在');
        return;
    }
    
    try {
        // 按 offset 排序
        chunks.sort((a, b) => a.offset - b.offset);
        
        // 计算总大小
        const totalSize = chunks.reduce((sum, c) => sum + c.data.length, 0);
        
        // 直接拼接 Uint8Array（data 已经是原始二进制，无需 Base64 解码）
        const result = new Uint8Array(totalSize);
        let pos = 0;
        for (const chunk of chunks) {
            result.set(chunk.data, pos);
            pos += chunk.data.length;
        }
        
        // 创建 Blob 并下载
        const blob = new Blob([result]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileInfo.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        console.log('文件已保存: ' + fileInfo.filename);
        showMessage('文件已保存: ' + fileInfo.filename);
        
        // 清理内存
        discardReceivedFile(fileId);
    } catch (e) {
        console.error('保存文件失败: ' + e.message);
        showMessage('保存文件失败: ' + e.message);
    }
}

function handleError(data) {
    showMessage('错误: ' + (data.message || '未知错误'));
}

// 丢弃接收到的文件（清理内存）
function discardReceivedFile(fileId) {
    delete receivedFiles[fileId];
    delete receivedFileChunks[fileId];
    
    const item = document.getElementById('progress_' + fileId);
    if (item) {
        item.style.opacity = '0.3';
        setTimeout(function() { item.remove(); }, 500);
    }
}

// ===== 工具函数 =====
function showMessage(text) {
    const messageList = document.getElementById('messageList');
    document.getElementById('messageSection').style.display = 'block';
    
    const item = document.createElement('div');
    item.className = 'message-item';
    item.innerHTML = '<div class="message-content" style="color: #666;">' + text + '</div>';
    
    messageList.appendChild(item);
    messageList.scrollTop = messageList.scrollHeight;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// HTML 属性转义（用于 data-* 属性中的值）
function escapeAttr(text) {
    return encodeURIComponent(String(text));
}

// ===== 退出 =====
function logout() {
    sessionStorage.removeItem('auth_token');
    sessionStorage.removeItem('client_id');
    
    // 清理所有连接
    if (typeof cleanupAllWebRTC === 'function') {
        cleanupAllWebRTC();
    }
    if (typeof closeWebSocket === 'function') {
        closeWebSocket();
    }
    
    window.location.href = 'index.html';
}