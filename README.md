# Docker OpenCode & EasyTier Mesh 环境

这是一个专注 **AI 辅助研发 (OpenCode)** 并内置 **EasyTier 无感异地组网** 的多功能 Docker 镜像。它可以轻松部署在任何支持 Docker 的云主机、NAS 甚至是免费的无公网 PaaS 平台（如 Railway、Render、Koyeb）上。

通过极简的短小写环境变量配置，即可获得一个带代码工作区、Web 终端、SSH 访问、公网/内网穿透的完整云端开发机！

---

## 🚀 核心特性

- **开箱即用的 AI IDE**：内置最新版 `OpenCode`，支持一键启动 Web 模式（直接在浏览器写代码）或 Serve 模式（通过本地 IDE attach）。
- **EasyTier 异地 P2P 组网**：只要配置相同的网络名，无论容器跑在哪里（即使无公网 IP、无入站端口），都能与你的本地电脑组成一个虚拟局域网（例如 `10.144.144.x`），实现极低延迟直连。
- **自定义数据持久化**：告别写死路径。通过 `data_dir` 变量随心定义数据落盘位置（包含代码库、配置、密钥等），并可直接映射到宿主机。
- **丰富的内置工具链**：包含 Node.js、Python3、Git、cURL 以及一整套系统基础运维与编译工具。

---

## ⚡ 60 秒上手部署

### 基础部署 (仅启动 OpenCode + Web终端)
```bash
docker run -d --name opencode-box \
  -e user="zv" \
  -e pwd="your_password" \
  -e data_dir="/data" \
  -v /opt/opencode_data:/data \
  -p 4096:4096 -p 7681:7681 -p 2222:22 \
  ghcr.io/zv201413/zvps:latest
```
* **OpenCode Web UI**: `http://<host>:4096`
* **Web 终端**: `http://<host>:7681`
* **SSH 登录**: `ssh zv@<host> -p 2222`

### 异地组网部署 (无公网打洞/多地协同开发)
适用于 Railway 等无法暴露端口的环境，只需加入 `et_name` 即可激活 EasyTier：
```bash
docker run -d --name opencode-mesh \
  -e user="zv" -e pwd="your_password" \
  -e data_dir="/data" \
  -e et_name="my-opencode-mesh" \
  -e et_secret="my-mesh-pass" \
  -e et_ip="10.144.144.10" \
  -e api_key="sk-xxxxxx" \
  -v /opt/opencode_data:/data \
  --restart unless-stopped \
  ghcr.io/zv201413/zvps:latest
```
部署后，在你的本地电脑（Mac/Windows）同样安装并启动 EasyTier：
`easytier-core -n my-opencode-mesh -s my-mesh-pass`
此时你的电脑可以直接通过 `http://10.144.144.10:4096` 访问容器的 IDE，安全、私密且高速！

---

## ⚙️ 环境变量速查

所有变量均支持极简的**小写格式**（向后兼容大写）。

### 1. 核心与持久化
| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `data_dir` | `/data` | 数据持久化挂载目录，强烈建议映射到外部 Volume。所有代码将存放在 `$data_dir/workspace` |
| `user` | `zv` | SSH 和系统用户名 |
| `pwd` | `105106` | SSH 登录密码，**部署时请务必修改** |

### 2. OpenCode 配置
| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `oc_mode` | `web` | 运行模式：`web` (网页 UI), `serve` (后端 API 供 IDE 连接), `off` (关闭) |
| `oc_port` | `4096` | 服务监听端口 |
| `oc_model` | （无） | 指定使用的 AI 模型（如 `deepseek/deepseek-chat`） |
| `api_key` | （无） | 通用大模型 API 密钥。也可使用 `deepseek_key`, `openai_key` 等平台专属变量 |
| `oc_args` | （无） | 其他附加启动参数 |

### 3. EasyTier 异地组网
| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `et_name` | （关） | EasyTier 虚拟局域网名称，**非空即自动激活组网** |
| `et_secret`| （空） | 网络验证密码 |
| `et_ip` | （DHCP分配）| 指定容器在虚拟网络中的静态 IPv4 地址（如 `10.144.144.5`） |
| `et_peers` | （空） | 指定要连接的 Peer/中继（如 `tcp://public.easytier.top:11010`） |
| `et_args` | （空） | 其他附加启动参数 |

### 4. 其他穿透工具
| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `ttyd_port`| `7681` | Web 终端端口，设为 `0` 或 `off` 可关闭 |
| `ttyd_auth`| （空） | Web 终端账号密码保护（格式：`admin:password`） |
| `cf_token` | （关） | Cloudflare Tunnel Token，填入后将通过 CF 代理对外暴露服务 |

---

## 💡 持久化说明 (`data_dir`)

传统的容器由于用户不同，主目录也会变动，导致文件难以长期保存。现在采用动态挂载逻辑：
只要您将外部卷挂载给 `data_dir` 指定的路径（默认 `/data`），内部将自动接管：
- `workspace/`：您的开发代码存放处。
- `.config/opencode/`：OpenCode 的配置和本地会话缓存。
- `.ssh/`：SSH 公钥认证信息。

即使容器重建，您的所有开发进度和 AI 历史记录都会安然无恙！
