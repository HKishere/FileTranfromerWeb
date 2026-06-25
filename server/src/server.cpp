#include "server.h"

Server::Server(int port, const std::string& passwdFile)
    : m_port(port)
    , m_passwdFile(passwdFile)
    , m_running(false)
{
}

Server::~Server() {
    stop();
}

bool Server::loadPassword() {
    std::ifstream file(m_passwdFile);
    if (!file.is_open()) {
        std::cerr << "Failed to open password file: " << m_passwdFile << std::endl;
        return false;
    }
    std::getline(file, m_password);
    file.close();
    if (m_password.empty()) {
        std::cerr << "Password file is empty" << std::endl;
        return false;
    }
    while (!m_password.empty() && (m_password.back() == '\n' || m_password.back() == '\r')) {
        m_password.pop_back();
    }
    std::cout << "Password loaded successfully" << std::endl;
    return true;
}

void Server::initJwtSecret() {
    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_int_distribution<> dis(0, 15);
    std::stringstream ss;
    ss << m_password << "_";
    for (int i = 0; i < 32; i++) {
        ss << std::hex << dis(gen);
    }
    m_jwtSecret = ss.str();
}

std::string Server::base64UrlEncode(const std::string& data) {
    if (data.empty()) return "";
    
    BIO* bio = BIO_new(BIO_s_mem());
    BIO* b64 = BIO_new(BIO_f_base64());
    BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
    BIO_push(b64, bio);
    BIO_write(b64, data.data(), data.size());
    (void)BIO_flush(b64);
    
    BUF_MEM* bufferPtr = nullptr;
    BIO_get_mem_ptr(b64, &bufferPtr);
    
    std::string result(bufferPtr->data, bufferPtr->length);
    BIO_free_all(b64);
    
    // Base64 URL safe: replace + with -, / with _, remove padding =
    for (auto& c : result) {
        if (c == '+') c = '-';
        else if (c == '/') c = '_';
    }
    size_t pos = result.find('=');
    if (pos != std::string::npos) {
        result = result.substr(0, pos);
    }
    
    return result;
}

std::string Server::base64UrlDecode(const std::string& data) {
    if (data.empty()) return "";
    
    std::string base64 = data;
    // Restore standard base64
    for (auto& c : base64) {
        if (c == '-') c = '+';
        else if (c == '_') c = '/';
    }
    // Add padding
    while (base64.size() % 4 != 0) {
        base64 += '=';
    }
    
    BIO* bio = BIO_new_mem_buf(base64.data(), base64.size());
    BIO* b64 = BIO_new(BIO_f_base64());
    BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
    BIO_push(b64, bio);
    
    std::vector<char> buffer(base64.size());
    int len = BIO_read(b64, buffer.data(), buffer.size());
    BIO_free_all(b64);
    
    if (len <= 0) return "";
    return std::string(buffer.data(), len);
}

std::string Server::hmacSha256(const std::string& key, const std::string& data) {
    unsigned char result[EVP_MAX_MD_SIZE];
    unsigned int resultLen = 0;
    
    HMAC(EVP_sha256(), key.data(), key.size(),
         reinterpret_cast<const unsigned char*>(data.data()), data.size(),
         result, &resultLen);
    
    return std::string(reinterpret_cast<char*>(result), resultLen);
}

std::string Server::generateToken(const std::string& clientId) {
    // Header: {"alg":"HS256","typ":"JWT"}
    std::string header = "{\"alg\":\"HS256\",\"typ\":\"JWT\"}";
    
    // Payload: {"iss":"filetransfer","sub":"clientId","iat":timestamp,"exp":timestamp+86400}
    auto now = std::chrono::system_clock::now();
    auto nowSec = std::chrono::duration_cast<std::chrono::seconds>(now.time_since_epoch()).count();
    auto expSec = nowSec + 86400; // 24 hours
    
    std::stringstream payload;
    payload << "{\"iss\":\"filetransfer\",\"sub\":\"" << clientId
            << "\",\"iat\":" << nowSec << ",\"exp\":" << expSec << "}";
    
    std::string headerEncoded = base64UrlEncode(header);
    std::string payloadEncoded = base64UrlEncode(payload.str());
    std::string signingInput = headerEncoded + "." + payloadEncoded;
    
    std::string signature = hmacSha256(m_jwtSecret, signingInput);
    std::string signatureEncoded = base64UrlEncode(signature);
    
    return signingInput + "." + signatureEncoded;
}

bool Server::verifyToken(const std::string& token, std::string& outClientId) {
    try {
        // Split token by '.'
        size_t firstDot = token.find('.');
        size_t lastDot = token.rfind('.');
        if (firstDot == std::string::npos || lastDot == std::string::npos || firstDot == lastDot) {
            return false;
        }
        
        std::string headerEncoded = token.substr(0, firstDot);
        std::string payloadEncoded = token.substr(firstDot + 1, lastDot - firstDot - 1);
        std::string signatureEncoded = token.substr(lastDot + 1);
        
        // Verify signature
        std::string signingInput = headerEncoded + "." + payloadEncoded;
        std::string expectedSignature = hmacSha256(m_jwtSecret, signingInput);
        std::string expectedSignatureEncoded = base64UrlEncode(expectedSignature);
        
        if (signatureEncoded != expectedSignatureEncoded) {
            return false;
        }
        
        // Decode payload
        std::string payloadJson = base64UrlDecode(payloadEncoded);
        
        // Parse subject (clientId) from JSON
        // Simple JSON parsing: find "sub":"value"
        size_t subPos = payloadJson.find("\"sub\":\"");
        if (subPos == std::string::npos) return false;
        subPos += 7;
        size_t subEnd = payloadJson.find("\"", subPos);
        if (subEnd == std::string::npos) return false;
        outClientId = payloadJson.substr(subPos, subEnd - subPos);
        
        // Check expiration
        size_t expPos = payloadJson.find("\"exp\":");
        if (expPos == std::string::npos) return false;
        expPos += 6;
        size_t expEnd = payloadJson.find_first_of(",}", expPos);
        if (expEnd == std::string::npos) return false;
        long long expTime = std::stoll(payloadJson.substr(expPos, expEnd - expPos));
        
        auto now = std::chrono::system_clock::now();
        auto nowSec = std::chrono::duration_cast<std::chrono::seconds>(now.time_since_epoch()).count();
        if (nowSec > expTime) {
            return false; // Token expired
        }
        
        // Check issuer
        if (payloadJson.find("\"iss\":\"filetransfer\"") == std::string::npos) {
            return false;
        }
        
        return true;
    } catch (const std::exception& e) {
        std::cerr << "Token verification failed: " << e.what() << std::endl;
        return false;
    }
}

bool Server::start() {
    if (!loadPassword()) {
        return false;
    }
    initJwtSecret();
    
    m_wsServer.setOpenCallback(std::bind(&Server::onWebSocketOpen, this,
        std::placeholders::_1, std::placeholders::_2));
    m_wsServer.setCloseCallback(std::bind(&Server::onWebSocketClose, this,
        std::placeholders::_1));
    m_wsServer.setMessageCallback(std::bind(&Server::onWebSocketMessage, this,
        std::placeholders::_1, std::placeholders::_2));
    
    if (!m_wsServer.init(m_port)) {
        return false;
    }
    m_running = true;
    return true;
}

void Server::stop() {
    m_running = false;
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_clients.clear();
        m_clientIdToFd.clear();
    }
    m_wsServer.stop();
}

void Server::run() {
    if (!m_running) {
        std::cerr << "Server is not running" << std::endl;
        return;
    }
    m_wsServer.run();
    
    while (m_running) {
        std::this_thread::sleep_for(std::chrono::seconds(5));
        auto now = std::chrono::steady_clock::now();
        std::lock_guard<std::mutex> lock(m_mutex);
        for (auto& [fd, client] : m_clients) {
            if (client.authenticated) {
                auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - client.lastPing).count();
                if (elapsed > 30) {
                    m_wsServer.sendPing(fd);
                    client.lastPing = now;
                }
            }
        }
    }
}

void Server::onWebSocketOpen(int fd, const std::string& address) {
    ClientInfo client;
    client.fd = fd;
    client.id = generateClientId();
    client.address = address;
    client.authenticated = false;
    client.lastPing = std::chrono::steady_clock::now();
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_clients[fd] = client;
    }
    std::cout << "New connection from " << address << " (fd=" << fd << ")" << std::endl;
}

void Server::onWebSocketClose(int fd) {
    std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_clients.find(fd);
    if (it != m_clients.end()) {
        std::cout << "Client disconnected: " << it->second.id << " (" << it->second.address << ")" << std::endl;
        m_clientIdToFd.erase(it->second.id);
        m_clients.erase(it);
        broadcastClientList();
    }
}

void Server::onWebSocketMessage(int fd, const WebSocketFrame& frame) {
    switch (frame.opcode) {
        case WebSocketOpcode::TEXT: {
            std::string message(frame.payloadData.begin(), frame.payloadData.end());
            std::cout << message << std::endl;
            auto parseJson = [](const std::string& json, const std::string& key) -> std::string {
                std::string searchKey = "\"" + key + "\":\"";
                size_t pos = json.find(searchKey);
                if (pos == std::string::npos) {
                    searchKey = "\"" + key + "\":";
                    pos = json.find(searchKey);
                    if (pos == std::string::npos) return "";
                    pos += searchKey.length();
                    size_t end = json.find_first_of(",}", pos);
                    if (end == std::string::npos) return "";
                    return json.substr(pos, end - pos);
                }
                pos += searchKey.length();
                size_t end = json.find("\"", pos);
                if (end == std::string::npos) return "";
                return json.substr(pos, end - pos);
            };
            std::string type = parseJson(message, "type");
            if (type == "auth") {
                std::string password = parseJson(message, "password");
                handleAuth(fd, password);
            } else if (type == "token_auth") {
                std::string token = parseJson(message, "token");
                handleTokenAuth(fd, token);
            } else if (type == "text") {
                std::string toId = parseJson(message, "to");
                std::string content = parseJson(message, "content");
                handleTextMessage(fd, toId, content);
            } else if (type == "file_meta") {
                std::string toId = parseJson(message, "to");
                std::string fileName = parseJson(message, "filename");
                std::string fileSizeStr = parseJson(message, "filesize");
                std::string fileId = parseJson(message, "fileid");
                uint64_t fileSize = std::stoull(fileSizeStr);
                handleFileMeta(fd, toId, fileName, fileSize, fileId);
            } else if (type == "webrtc_offer" || type == "webrtc_answer" || type == "webrtc_ice") {
                handleWebRTCSignaling(fd, type, message);
            } else if (type == "file_chunk") {
                std::string fileId = parseJson(message, "fileid");
                std::string offsetStr = parseJson(message, "offset");
                std::string data = parseJson(message, "data");
                uint64_t offset = std::stoull(offsetStr);
                handleFileChunk(fd, fileId, offset, data);
            }
            break;
        }
        case WebSocketOpcode::PING:
            m_wsServer.sendPong(fd, frame.payloadData);
            break;
        case WebSocketOpcode::PONG: {
            auto it = m_clients.find(fd);
            if (it != m_clients.end()) it->second.lastPing = std::chrono::steady_clock::now();
            break;
        }
        case WebSocketOpcode::CLOSE:
            onWebSocketClose(fd);
            break;
        default:
            break;
    }
}

void Server::handleAuth(int fd, const std::string& password) {
    std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_clients.find(fd);
    if (it == m_clients.end()) return;
    
    bool success = (password == m_password);
    if (success) {
        it->second.authenticated = true;
        it->second.name = "Client-" + it->second.id.substr(0, 8);
        m_clientIdToFd[it->second.id] = fd;
        
        std::string token = generateToken(it->second.id);
        std::cout << "Client " << it->second.id << " authenticated successfully" << std::endl;
        
        std::string authMsg = "{\"type\":\"auth_result\",\"success\":true,\"client_id\":\""
            + it->second.id + "\",\"token\":\"" + token + "\"}";
        m_wsServer.sendText(fd, authMsg);
        broadcastClientList();
    } else {
        std::cout << "Authentication failed for fd=" << fd << std::endl;
        m_wsServer.sendText(fd, "{\"type\":\"auth_result\",\"success\":false}");
    }
}

void Server::handleTokenAuth(int fd, const std::string& token) {
    std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_clients.find(fd);
    if (it == m_clients.end()) return;
    
    std::string clientId;
    if (verifyToken(token, clientId)) {
        it->second.authenticated = true;
        it->second.name = "Client-" + clientId.substr(0, 8);
        it->second.id = clientId;
        m_clientIdToFd[clientId] = fd;
        
        std::cout << "Client " << clientId << " re-authenticated via token" << std::endl;
        
        std::string authMsg = "{\"type\":\"auth_result\",\"success\":true,\"client_id\":\""
            + clientId + "\"}";
        m_wsServer.sendText(fd, authMsg);
        broadcastClientList();
    } else {
        std::cout << "Token auth failed for fd=" << fd << std::endl;
        m_wsServer.sendText(fd, "{\"type\":\"auth_result\",\"success\":false}");
    }
}

void Server::handleTextMessage(int fd, const std::string& toClientId, const std::string& content) {
    std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_clients.find(fd);
    if (it == m_clients.end()) return;
    
    if (content.size() > 40860) {
        m_wsServer.sendText(fd, "{\"type\":\"error\",\"message\":\"Text too long (max 40860 bytes)\"}");
        return;
    }
    
    auto targetIt = m_clientIdToFd.find(toClientId);
    if (targetIt == m_clientIdToFd.end()) {
        m_wsServer.sendText(fd, "{\"type\":\"error\",\"message\":\"Target client not found\"}");
        return;
    }
    
    std::string msg = "{\"type\":\"text\",\"from\":\"" + it->second.id
        + "\",\"from_name\":\"" + it->second.name
        + "\",\"content\":\"" + content + "\"}";
    m_wsServer.sendText(targetIt->second, msg);
    std::cout << "Text message forwarded from " << it->second.id << " to " << toClientId << std::endl;
}

void Server::handleFileMeta(int fd, const std::string& toClientId, const std::string& fileName,
                             uint64_t fileSize, const std::string& fileId) {
    std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_clients.find(fd);
    if (it == m_clients.end()) return;
    
    auto targetIt = m_clientIdToFd.find(toClientId);
    if (targetIt == m_clientIdToFd.end()) {
        m_wsServer.sendText(fd, "{\"type\":\"error\",\"message\":\"Target client not found\"}");
        return;
    }
    
    FileTransferInfo ftInfo;
    ftInfo.fileId = fileId;
    ftInfo.fileName = fileName;
    ftInfo.fileSize = fileSize;
    ftInfo.bytesSent = 0;
    ftInfo.fromClientId = it->second.id;
    ftInfo.toClientId = toClientId;
    ftInfo.startTime = std::chrono::steady_clock::now();
    ftInfo.complete = false;
    ftInfo.fileData.reserve(fileSize);
    
    m_fileTransfers[fileId] = ftInfo;
    
    std::string metaMsg = "{\"type\":\"file_meta\",\"from\":\"" + it->second.id
        + "\",\"from_name\":\"" + it->second.name
        + "\",\"filename\":\"" + fileName
        + "\",\"filesize\":" + std::to_string(fileSize)
        + ",\"fileid\":\"" + fileId + "\"}";
    m_wsServer.sendText(targetIt->second, metaMsg);
    std::cout << "File transfer started: " << fileName << " (" << fileSize << " bytes) from "
              << it->second.id << " to " << toClientId << std::endl;
}

void Server::handleWebRTCSignaling(int fd, const std::string& type, const std::string& message) {
    // WebRTC 信令消息 - 透传给目标客户端
    // 解析目标客户端 ID
    auto parseTo = [](const std::string& json) -> std::string {
        std::string searchKey = "\"to\":\"";
        size_t pos = json.find(searchKey);
        if (pos == std::string::npos) return "";
        pos += searchKey.length();
        size_t end = json.find("\"", pos);
        if (end == std::string::npos) return "";
        return json.substr(pos, end - pos);
    };
    
    std::string toClientId = parseTo(message);
    if (toClientId.empty()) return;
    
    // 在转发的消息中添加 from 字段
    std::string fromId;
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        auto it = m_clients.find(fd);
        if (it == m_clients.end() || !it->second.authenticated) return;
        fromId = it->second.id;
    }
    
    // 转发消息给目标客户端（添加 from 字段）
    std::string forwardMsg = "{\"type\":\"" + type + "\",\"from\":\"" + fromId + "\"";
    // 复制原始消息中的其他字段（sdp, candidate 等）
    size_t toPos = message.find("\"to\"");
    if (toPos != std::string::npos) {
        // 跳过 type 和 to 字段，复制其余部分
        size_t restPos = message.find(",", message.find("\"type\""));
        if (restPos == std::string::npos) restPos = message.find(",", toPos);
        if (restPos != std::string::npos) {
            forwardMsg += "," + message.substr(restPos + 1);
        } else {
            forwardMsg += "}";
        }
    } else {
        forwardMsg += "}";
    }
    
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        auto targetIt = m_clientIdToFd.find(toClientId);
        if (targetIt == m_clientIdToFd.end()) return;
        m_wsServer.sendText(targetIt->second, forwardMsg);
    }
    
    std::cout << "WebRTC signaling (" << type << ") forwarded from " << fromId << " to " << toClientId << std::endl;
}


void Server::handleFileChunk(int fd, const std::string& fileId, uint64_t offset, const std::string& data) {
    std::lock_guard<std::mutex> lock(m_mutex);
    
    auto ftIt = m_fileTransfers.find(fileId);
    if (ftIt == m_fileTransfers.end()) return;
    auto& ftInfo = ftIt->second;
    
    std::vector<uint8_t> decodedData = WebSocket::base64Decode(data);
    ftInfo.fileData.insert(ftInfo.fileData.end(), decodedData.begin(), decodedData.end());
    ftInfo.bytesSent += decodedData.size();
    
    auto targetIt = m_clientIdToFd.find(ftInfo.toClientId);
    if (targetIt == m_clientIdToFd.end()) return;
    
    std::string chunkMsg = "{\"type\":\"file_chunk\",\"fileid\":\"" + fileId
        + "\",\"offset\":" + std::to_string(offset)
        + ",\"data\":\"" + data + "\"}";
    m_wsServer.sendText(targetIt->second, chunkMsg);
    
    auto now = std::chrono::steady_clock::now();
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - ftInfo.startTime).count();
    double speed = (elapsed > 0) ? (ftInfo.bytesSent * 1000.0 / elapsed) : 0.0;
    
    std::string speedStr;
    if (speed > 1024 * 1024) {
        speedStr = std::to_string(speed / (1024 * 1024)).substr(0, 4) + " MB/s";
    } else if (speed > 1024) {
        speedStr = std::to_string(speed / 1024).substr(0, 4) + " KB/s";
    } else {
        speedStr = std::to_string((int)speed) + " B/s";
    }
    
    std::string progressMsg = "{\"type\":\"file_progress\",\"fileid\":\"" + fileId
        + "\",\"sent\":" + std::to_string(ftInfo.bytesSent)
        + ",\"total\":" + std::to_string(ftInfo.fileSize)
        + ",\"speed\":\"" + speedStr + "\"}";
    m_wsServer.sendText(fd, progressMsg);
    
    if (ftInfo.bytesSent >= ftInfo.fileSize) {
        ftInfo.complete = true;
        std::string completeMsg = "{\"type\":\"file_complete\",\"fileid\":\"" + fileId
            + "\",\"filename\":\"" + ftInfo.fileName + "\"}";
        m_wsServer.sendText(fd, completeMsg);
        m_wsServer.sendText(targetIt->second, completeMsg);
        std::cout << "File transfer complete: " << ftInfo.fileName << std::endl;
        m_fileTransfers.erase(fileId);
    }
}

void Server::broadcastClientList() {
    std::ostringstream oss;
    oss << "{\"type\":\"client_list\",\"clients\":[";
    bool first = true;
    for (auto& [fd, client] : m_clients) {
        if (client.authenticated) {
            if (!first) oss << ",";
            oss << "{\"id\":\"" << client.id << "\",\"name\":\"" << client.name << "\"}";
            first = false;
        }
    }
    oss << "]}";
    std::string message = oss.str();
    m_wsServer.broadcastText(message, [this](int fd) -> bool {
        auto it = m_clients.find(fd);
        return it != m_clients.end() && it->second.authenticated;
    });
}

std::string Server::generateClientId() {
    static std::random_device rd;
    static std::mt19937 gen(rd());
    static std::uniform_int_distribution<> dis(0, 15);
    std::stringstream ss;
    for (int i = 0; i < 16; i++) {
        ss << std::hex << dis(gen);
    }
    return ss.str();
}

std::string Server::getCurrentTime() {
    auto now = std::chrono::system_clock::now();
    auto in_time_t = std::chrono::system_clock::to_time_t(now);
    std::stringstream ss;
    ss << std::put_time(std::localtime(&in_time_t), "%Y-%m-%d %H:%M:%S");
    return ss.str();
}
