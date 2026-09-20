# P2P 文件传输工具

基于标准 JavaScript 和标准 C++ 的 P2P 文件传输工具，部署在 x86 Linux 环境中。

## 功能特性

- **鉴权系统**：固定密码鉴权，密码保存在 `~/passwd` 文件中
- **客户端列表**：实时显示所有已连接并认证的客户端
- **文本传输**：发送文本消息给指定客户端（最大 40860 字节）
- **文件传输**：支持拖拽和选择文件两种方式发送文件
- **进度显示**：实时显示传输速度和进度条

## 项目结构

```
FileTranfromerWeb/
├── server/                    # C++ 服务器
│   ├── CMakeLists.txt         # CMake 构建配置
│   ├── src/
│   │   ├── main.cpp           # 入口文件
│   │   ├── server.h           # 服务器头文件
│   │   ├── server.cpp         # 服务器实现
│   │   ├── websocket.h        # WebSocket 协议头文件
│   │   └── websocket.cpp      # WebSocket 协议实现
│   └── build/                 # 构建目录
├── web/                       # 前端文件
│   ├── index.html             # 鉴权页面
│   ├── dashboard.html         # 主页面
│   ├── css/
│   │   └── style.css          # 样式文件
│   └── js/
│       ├── auth.js            # 鉴权逻辑
│       ├── websocket.js       # WebSocket 连接管理
│       └── dashboard.js       # 主页面逻辑
└── README.md
```

## 环境要求

- **操作系统**：x86 Linux（如 Ubuntu 20.04+、CentOS 7+ 等）
- **编译器**：g++ 支持 C++17
- **构建工具**：CMake 3.10+
- **依赖库**：OpenSSL（libssl-dev）
- **浏览器**：支持 WebSocket 的现代浏览器

## 安装依赖

### Ubuntu/Debian
```bash
sudo apt-get update
sudo apt-get install -y g++ cmake libssl-dev
```

### CentOS/RHEL
```bash
sudo yum install -y gcc-c++ cmake openssl-devel
```

## 构建

```bash
cd server
mkdir -p build
cd build
cmake ..
make
```

## 配置密码

在用户家目录下创建密码文件：

```bash
echo "kishereisgod" > ~/passwd
```

## 运行

### 默认配置（端口 80）
```bash
# 需要 root 权限（端口 80 需要特权）
sudo ./server/build/fileserver
```

### 自定义端口
```bash
# 使用非特权端口（如 8080）
./server/build/fileserver -p 8080
```

### 命令行参数
```
-p <port>      监听端口（默认：80）
-w <path>      Web 根目录（默认：../web）
-f <file>      密码文件路径（默认：~/passwd）
-h             显示帮助信息
```

## 使用说明

1. **启动服务器**：运行 `fileserver` 可执行文件
2. **访问页面**：在浏览器中打开 `http://服务器IP:端口`
3. **鉴权**：输入密码 `kishereisgod` 进行鉴权
4. **选择客户端**：在左侧客户端列表中选择目标
5. **发送文本**：在文本框中输入内容，点击"发送文本"
6. **发送文件**：
   - 拖拽文件到拖拽区域
   - 或点击"选择文件"按钮选择文件
   - 点击"发送文件"开始传输
7. **查看进度**：传输过程中会显示进度条和实时速度
8. **保存接收到的文件**：文件收齐后，"传输进度"卡片会高亮并出现 **💾 保存文件** 按钮，点击即保存到本地；点击 **🗑️ 丢弃** 可释放内存

> 说明：接收方在“已接收字节数 == 文件大小”时即认为传输完成并显示保存按钮；
> 服务端在收齐二进制分片后也会下发 `file_complete`（含 `filename` / `filesize`），两条路径互为兜底。
> 若修改了服务端 `server/src/server.cpp`，需要重新编译并重启服务端才能生效。

## 通信协议

基于 WebSocket 的 JSON 消息格式：

| 消息类型 | 方向 | 说明 |
|---------|------|------|
| `auth` | 客户端→服务器 | 鉴权请求 |
| `auth_result` | 服务器→客户端 | 鉴权结果 |
| `client_list` | 服务器→客户端 | 在线客户端列表 |
| `text` | 双向 | 文本消息 |
| `file_meta` | 发送方→服务器→接收方 | 文件元信息（文件名/大小/fileid） |
| `file_chunk` | 发送方→服务器→接收方 | 文件数据块（二进制直传，无 Base64） |
| `file_progress` | 服务器→发送方 | 传输进度 |
| `file_complete` | 服务器→双方 | 传输完成（接收方据此显示下载按钮） |

## 技术细节

- **WebSocket 实现**：基于 websocketpp（Boost.Asio）实现握手、帧编解码与心跳
- **文件分块**：每块 64KB，采用二进制协议直传（`[1B type][2B fileIdLen][fileId][8B offset][4B dataLen][data]`），服务端只解析头部路由、原样透传，无 Base64 编解码开销
- **传输完成信令**：服务端在收齐全部分片后向收发双方下发 `file_complete`；接收方同时以字节数自校验兜底，保证"保存文件"按钮一定出现
- **P2P 直连**：可选 WebRTC DataChannel 直传，失败自动降级为 WebSocket 中继
- **客户端管理**：使用随机 16 字节十六进制 ID 标识每个客户端
- **心跳检测**：每 30 秒发送 Ping 帧检测连接状态
