// 传输层抽象 - 统一 WebSocket 和 WebRTC 接口
// WebRTC 连接需要用户手动触发，不再自动连接
// 依赖: websocket.js (sendMessage), webrtc.js (createOffer, handleOffer, handleAnswer, handleIceCandidate, isWebRTCSupported, sendViaWebRTC)

let currentMode = 'websocket';  // 'websocket' | 'webrtc'
let targetClientId = null;
let messageHandlers = {};

// 传输模式回调
let onModeChangeCallback = null;

// 初始化传输层
function initTransport() {
    // 检查 WebRTC 支持
    if (typeof isWebRTCSupported === 'function' && isWebRTCSupported()) {
        console.log('WebRTC is supported, will try P2P when available');
    } else {
        console.log('WebRTC not supported, using WebSocket only');
    }
}

// 当选择目标客户端时调用 - 不再自动发起 WebRTC 连接
function selectTarget(clientId) {
    targetClientId = clientId;
    // 不再自动调用 createOffer，改为由用户手动触发
}

// 手动发起 P2P 连接
function manualConnectP2P(clientId) {
    if (typeof createOffer === 'function' && isWebRTCSupported()) {
        return createOffer(clientId);
    }
    return false;
}

// 取消选择目标
function deselectTarget() {
    targetClientId = null;
}

// 发送消息 - 自动选择最佳传输方式
function transportSend(data) {
    // 优先尝试 WebRTC
    if (currentMode === 'webrtc' && targetClientId) {
        if (typeof sendViaWebRTC === 'function') {
            const success = sendViaWebRTC(targetClientId, data);
            if (success) return true;
            // WebRTC 发送失败，降级到 WebSocket
            console.log('WebRTC send failed, falling back to WebSocket');
            setMode('websocket');
        }
    }
    
    // 回退到 WebSocket
    if (typeof sendMessage === 'function') {
        // 确保消息包含目标
        const wsData = Object.assign({}, data);
        if (!wsData.to && targetClientId) {
            wsData.to = targetClientId;
        }
        return sendMessage(wsData);
    }
    
    return false;
}

// 注册消息处理器
function transportOnMessage(type, handler) {
    messageHandlers[type] = handler;
}

// 分发接收到的消息（包括 WebRTC 信令）
function transportHandleMessage(data) {
    // WebRTC 信令消息直接路由到 webrtc.js
    if (data.type === 'webrtc_offer') {
        if (typeof handleOffer === 'function') {
            handleOffer(data.from, data.sdp);
        }
        return;
    }
    if (data.type === 'webrtc_answer') {
        if (typeof handleAnswer === 'function') {
            handleAnswer(data.from, data.sdp);
        }
        return;
    }
    if (data.type === 'webrtc_ice') {
        if (typeof handleIceCandidate === 'function') {
            handleIceCandidate(data.from, data.candidate);
        }
        return;
    }
    
    // 应用层消息通过已注册的处理器分发
    if (data.type && messageHandlers[data.type]) {
        messageHandlers[data.type](data);
    }
}

// 设置传输模式
function setMode(mode) {
    if (mode === currentMode) return;
    currentMode = mode;
    console.log('Transport mode changed to:', mode);
    
    if (onModeChangeCallback) {
        onModeChangeCallback(mode);
    }
}

// 获取当前传输模式
function getTransportMode() {
    return currentMode;
}

// 设置模式变更回调
function onTransportModeChange(callback) {
    onModeChangeCallback = callback;
}

// ===== WebRTC 事件回调注册 =====
// 这些会在 webrtc.js 加载后被调用

// WebRTC 连接成功
window.onWebRTCConnected = function(clientId) {
    console.log('WebRTC P2P connected to', clientId);
    if (clientId === targetClientId) {
        setMode('webrtc');
    }
    // 通知 UI 更新 P2P 标识
    if (window.onP2PStatusChange) {
        window.onP2PStatusChange(clientId, true);
    }
};

// WebRTC 断开
window.onWebRTCDisconnected = function(clientId) {
    console.log('WebRTC disconnected from', clientId);
    if (clientId === targetClientId) {
        setMode('websocket');
    }
    // 通知 UI 更新 P2P 标识
    if (window.onP2PStatusChange) {
        window.onP2PStatusChange(clientId, false);
    }
};

// WebRTC 消息到达
window.onWebRTCMessage = function(data) {
    // 通过 transport 层分发
    transportHandleMessage(data);
};

// 传输模式状态变化（更新 UI）
window.onTransportModeChange = function(mode) {
    setMode(mode);
};