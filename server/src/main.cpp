#include "server.h"
#include <iostream>
#include <csignal>
#include <cstdlib>

Server* g_server = nullptr;

void signalHandler(int signum) {
    std::cout << "\nReceived signal " << signum << ", shutting down..." << std::endl;
    if (g_server) {
        g_server->stop();
    }
    exit(0);
}

int main(int argc, char* argv[]) {
    int port = 8080;
    std::string passwdFile = std::string(getenv("HOME")) + "/passwd";
    
    // 解析命令行参数
    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "-p" && i + 1 < argc) {
            port = std::stoi(argv[++i]);
        } else if (arg == "-f" && i + 1 < argc) {
            passwdFile = argv[++i];
        } else if (arg == "-h") {
            std::cout << "Usage: " << argv[0] << " [options]" << std::endl;
            std::cout << "Options:" << std::endl;
            std::cout << "  -p <port>      Port to listen on (default: 8080)" << std::endl;
            std::cout << "  -f <file>      Password file path (default: ~/passwd)" << std::endl;
            std::cout << "  -h             Show this help" << std::endl;
            return 0;
        }
    }
    
    // 注册信号处理
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);
    
    // 创建并启动服务器（仅 WebSocket，Nginx 处理静态文件）
    Server server(port, passwdFile);
    g_server = &server;
    
    if (!server.start()) {
        std::cerr << "Failed to start server" << std::endl;
        return 1;
    }
    
    server.run();
    
    return 0;
}