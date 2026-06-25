// WebRTC P2P 连接管理
// 使用浏览器原生 RTCPeerConnection 实现点对点通信

let peerConnections = {};  // clientId -> RTCPeerConnection
let dataChannels = {};     // clientId -> RTCDataChannel
let pendingCandidates = {}; // clientId -> RTCIceCandidate[]

let webrtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// WebRTC 可用性检测
function isWebRTCSupported() {
    return typeof RTCPeerConnection !== 'undefined' || 
           typeof webkitRTCPeerConnection !== 'undefined';
}

// 创建与目标客户端的 WebRTC 连接（作为发起方）
function createOffer(targetClientId) {
    if (!isWebRTCSupported()) return false;
    if (peerConnections[targetClientId]) return true; // 已连接
    
    const pc = createPeerConnection(targetClientId);
    if (!pc) return false;
    
    try {
        const dc = pc.createDataChannel('filetransfer', {
            ordered: true
        });
        setupDataChannel(dc, targetClientId);
        dataChannels[targetClientId] = dc;
        
        pc.createOffer()
            .then(offer => pc.setLocalDescription(offer))
            .then(() => {
                // 通过 WebSocket 信令发送 offer
                sendWebSocketMessage({
                    type: 'webrtc_offer',
                    to: targetClientId,
                    sdp: pc.localDescription.sdp
                });
            })
            .catch(e => console.error('Create offer error:', e));
        
        return true;
    } catch (e) {
        console.error('Create offer failed:', e);
        cleanupConnection(targetClientId);
        return false;
    }
}

// 处理接受到的 Offer（作为应答方）
function handleOffer(fromClientId, sdp) {
    if (peerConnections[fromClientId]) {
        console.warn('Already have connection with', fromClientId);
        return;
    }
    
    const pc = createPeerConnection(fromClientId);
    if (!pc) return;
    
    // 处理 DataChannel 打开事件（由对端创建）
    pc.ondatachannel = function(event) {
        const dc = event.channel;
        setupDataChannel(dc, fromClientId);
        dataChannels[fromClientId] = dc;
    };
    
    const offer = new RTCSessionDescription({ type: 'offer', sdp: sdp });
    pc.setRemoteDescription(offer)
        .then(() => pc.createAnswer())
        .then(answer => pc.setLocalDescription(answer))
        .then(() => {
            sendWebSocketMessage({
                type: 'webrtc_answer',
                to: fromClientId,
                sdp: pc.localDescription.sdp
            });
        })
        .catch(e => console.error('Handle offer error:', e));
}

// 处理接受到的 Answer
function handleAnswer(fromClientId, sdp) {
    const pc = peerConnections[fromClientId];
    if (!pc) {
        console.error('No peer connection for', fromClientId);
        return;
    }
    
    const answer = new RTCSessionDescription({ type: 'answer', sdp: sdp });
    pc.setRemoteDescription(answer)
        .then(() => {
            // 发送积压的 ICE candidates
            const candidates = pendingCandidates[fromClientId] || [];
            candidates.forEach(candidate => {
                pc.addIceCandidate(new RTCIceCandidate(candidate))
                    .catch(e => console.error('Add pending candidate error:', e));
            });
            delete pendingCandidates[fromClientId];
        })
        .catch(e => console.error('Handle answer error:', e));
}

// 处理 ICE Candidate
function handleIceCandidate(fromClientId, candidate) {
    const pc = peerConnections[fromClientId];
    if (!pc) {
        // 还没建立连接，缓存起来
        if (!pendingCandidates[fromClientId]) {
            pendingCandidates[fromClientId] = [];
        }
        pendingCandidates[fromClientId].push(candidate);
        return;
    }
    
    pc.addIceCandidate(new RTCIceCandidate(candidate))
        .catch(e => console.error('Add ICE candidate error:', e));
}

// 创建 RTCPeerConnection
function createPeerConnection(targetClientId) {
    try {
        const RTCPeerConnection = window.RTCPeerConnection || 
                                   window.webkitRTCPeerConnection ||
                                   window.mozRTCPeerConnection;
        const pc = new RTCPeerConnection(webrtcConfig);
        
        pc.onicecandidate = function(event) {
            if (event.candidate) {
                sendWebSocketMessage({
                    type: 'webrtc_ice',
                    to: targetClientId,
                    candidate: event.candidate
                });
            }
        };
        
        pc.oniceconnectionstatechange = function() {
            const state = pc.iceConnectionState;
            console.log('ICE connection state:', state);
            updateConnectionMode(state === 'connected' || state === 'completed');
            
            if (state === 'disconnected' || state === 'failed' || state === 'closed') {
                console.log('WebRTC disconnected from', targetClientId);
                cleanupConnection(targetClientId);
                // 触发降级事件
                if (window.onWebRTCDisconnected) {
                    window.onWebRTCDisconnected(targetClientId);
                }
            }
        };
        
        peerConnections[targetClientId] = pc;
        return pc;
    } catch (e) {
        console.error('Create RTCPeerConnection failed:', e);
        return null;
    }
}

// 设置 DataChannel 回调
function setupDataChannel(dc, targetClientId) {
    dc.onopen = function() {
        console.log('DataChannel opened with', targetClientId);
        updateConnectionMode(true);
        if (window.onWebRTCConnected) {
            window.onWebRTCConnected(targetClientId);
        }
    };
    
    dc.onclose = function() {
        console.log('DataChannel closed with', targetClientId);
        cleanupConnection(targetClientId);
        if (window.onWebRTCDisconnected) {
            window.onWebRTCDisconnected(targetClientId);
        }
    };
    
    dc.onmessage = function(event) {
        try {
            const data = JSON.parse(event.data);
            // 通过全局消息分发
            if (window.onWebRTCMessage) {
                window.onWebRTCMessage(data);
            }
        } catch (e) {
            console.error('DataChannel message parse error:', e);
        }
    };
    
    dc.onerror = function(error) {
        console.error('DataChannel error:', error);
    };
}

// 通过 DataChannel 发送消息
function sendViaWebRTC(targetClientId, data) {
    const dc = dataChannels[targetClientId];
    if (!dc || dc.readyState !== 'open') {
        return false;
    }
    
    try {
        dc.send(JSON.stringify(data));
        return true;
    } catch (e) {
        console.error('Send via WebRTC failed:', e);
        return false;
    }
}

// 检查与目标客户端的 WebRTC 连接状态
function getWebRTCState(targetClientId) {
    const dc = dataChannels[targetClientId];
    if (dc && dc.readyState === 'open') return 'connected';
    if (peerConnections[targetClientId]) return 'connecting';
    return 'disconnected';
}

// 清理连接
function cleanupConnection(clientId) {
    const dc = dataChannels[clientId];
    if (dc) {
        dc.close();
        delete dataChannels[clientId];
    }
    
    const pc = peerConnections[clientId];
    if (pc) {
        pc.close();
        delete peerConnections[clientId];
    }
    
    delete pendingCandidates[clientId];
}

// 清理所有 WebRTC 连接
function cleanupAllWebRTC() {
    Object.keys(peerConnections).forEach(id => cleanupConnection(id));
}

// 更新连接模式显示
function updateConnectionMode(isP2P) {
    if (window.onTransportModeChange) {
        window.onTransportModeChange(isP2P ? 'webrtc' : 'websocket');
    }
}

// 辅助：发送 WebSocket 信令消息（通过 websocket.js 的全局函数）
function sendWebSocketMessage(data) {
    if (typeof sendMessage === 'function') {
        sendMessage(data);
    }
}
