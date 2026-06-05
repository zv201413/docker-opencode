# 🚀 ZVPS-Super 2026 增强版

基于 **Ubuntu** 的智能型容器基础镜像。支持通过环境变量动态接管启动进程，结合 **Supervisor** 实现多服务保活、**全自动配置初始化**与持久化存储。

---

## 🛠️ 部署方式 (Deployment Methods)

你可以根据使用环境选择以下两种并列的部署方式：

### A. 🐳 Docker 命令行部署 (Docker CLI)
适用于本地服务器或具有 Docker 访问权限的 VPS。

#### 1. ⚡ 极简启动 (仅 SSH + Web 终端)
```bash
docker run -d \
  --name zvps-super \
  -e SSH_PWD="your_password" \
  -p 2222:22 \
  -p 7681:7681 \
  zv201413/zvps-super
```

#### 2. 🚀 全功能启动 (持久化 + 隧道 + 保活)
```bash
docker run -d \
  --name zvps-super \
  -e SSH_USER="zv" \
  -e SSH_PWD="your_password" \
  -e GB=true \
  -e KPAL="240+60:https://your-monitor-url" \
  -e CF_TOKEN="your_cloudflare_token" \
  -e TTYD_P1="7681:admin:your_password" \
  -v /opt/zvps_data:/home/zv \
  -p 2222:22 \
  -p 7681:7681 \
  --restart unless-stopped \
  zv201413/zvps-super
```

---

### B. ☁️ 容器平台环境变量部署 (Cloud Platforms)
适用于 Zeabur, Railway, Render 等无直接 Docker 访问权限的平台。

#### 1. 一站式环境配置
在平台面板添加以下环境变量：

| 变量名 | 示例值 | 说明 |
| :--- | :--- | :--- |
| **SSH_USER** | `zv` | SSH 用户名（默认获得最高权限） |
| **SSH_PWD** | `105106` | SSH 登录密码 |
| **KPAL** | `300:60:URL` | **(新)** 循环保活配置。格式：`范围:偏移:URL` |
| **GB** | `true` | (可选) 开启后自动安装 vnstat 流量统计 |
| **CF_TOKEN** | `your_token` | (可选) 填入则自动激活 Cloudflared 隧道 |
| **TTYD_P1** | `7681:admin:123` | (可选) 第一个 Web 终端。格式：`端口:用户:密码` |
| **TTYD_P2** | `80:admin:123` | (可选) 第二个 Web 终端（用于 CF Tunnel 整合） |
| **KOMARI** | `wget -qO- ... \| bash -s -- -e URL -t TOKEN` | **(新)** 容器启动时执行一次任意 shell 命令/安装脚本 |
| **HYP2P** | `auth:obfs:进程名` | **(新)** P2P 打洞 hy2 出站代理总开关。格式 `认证密码:混淆密码:进程伪装名`（auth 空=关；密码**不能含冒号**） |
| **HYP2P_RV** | (留空) | (可选) 牵线服务器 URI；**留空自动用公共 `realm.hy2.io`** |

#### 2. 挂载持久化存储 (Storage) ⚠️
**重要：挂载路径必须与 SSH_USER 严格一致！**
- 若 `SSH_USER` = `root`：挂载到 `/root`
- 若 `SSH_USER` = `zv`：挂载到 `/home/zv`

---

## 📝 参数详解与进阶配置

### 📡 智能保活机制 (KPAL)
本项目集成了基于持久化循环脚本的动态保活功能（服务名：`kpal`）。

*   **变量格式**：`KPAL=范围:偏移:URL`
*   **示例**：`KPAL=300:60:https://example.com/status`
*   **缺省支持**：
    *   `300::URL` (偏移默认 60)
    *   `:60:URL` (范围默认 300)
    *   `URL` (范围默认 300，偏移默认 60)
*   **逻辑**：采用 `while true` 持久化循环，每次请求前随机等待 `RANDOM % 范围 + 偏移` 秒。

### 📡 自定义 Web 终端 (ttyd)
设置 `TTYD_P1` 或 `TTYD_P2` 环境变量即可自定义端口和密码。
*   **格式**: `端口:用户名:密码`（密码可省略）
*   **安全提示**: 建议始终设置密码以保护终端安全。

### 🚀 一次性初始化注入 (KOMARI)
设置 `KOMARI` 变量后，容器启动时 supervisord 会自动执行一次该变量中的命令（`autorestart=false`，失败不重试），执行完毕后退出。适合用于拉取安装脚本、初始化配置等一次性任务。

*   **典型用法**：配合 komari-agent 的 install.sh，容器启动时自动安装 agent：
    ```
    wget -qO- https://raw.githubusercontent.com/zv201413/komari-agent_new/refs/heads/main/install.sh | bash -s -- -e <ENDPOINT> -t <TOKEN>
    ```
*   **注意**: 支持 `KOMARI`（大写）和 `komari`（小写）两种变量名，大写优先。

### 📡 配合 Cloudflare Tunnel 使用
设置 `TTYD_P2=80:用户名:密码` 配合 `CF_TOKEN` 使用，可实现 80 端口直接穿透。
*   **CF 控制台配置**：Public Hostname 选 `HTTP`，URL 填 `localhost:80`。

### 🌐 P2P 打洞 hy2 出站代理 (HYP2P)

让容器在 NAT 后（无需公网入站端口）通过 **UDP 打洞**变成一个 **Hysteria2 出站代理落地**：你在本地用 hy2 客户端经 P2P 直连进来，流量从容器 IP 出站，全程带 Salamander 混淆。适合 Koyeb / Render / Zeabur 等开不了入站端口的平台。

**只需两个变量：**

| 变量 | 必填 | 说明 |
| :--- | :--- | :--- |
| `HYP2P` | ✅ | 总开关，格式 `<认证密码>:<混淆密码>:<进程伪装名>`。第 1 段 auth 留空=关闭；第 2 段 obfs 可空（空则不混淆）；第 3 段进程名可空（默认 `hy2`，可设 `nginx` 等规避按进程名检测） |
| `HYP2P_RV` | ❌ | 牵线（rendezvous）服务器 URI。**留空 → 自动用官方公共 `realm.hy2.io`**；填则用你自建的 |

> ⚠️ **密码不能含冒号 `:`** —— `HYP2P` 用冒号分三段，auth / obfs 含 `:` 会解析错位。密码请只用字母数字和 `-`（例：`koyeb-udp-p2p123`）。

#### ① 零配置（公共牵线）
只设 `HYP2P=你的密码:混淆密码:nginx`，不填 `HYP2P_RV`。容器自动用公共 `realm.hy2.io` 并**生成随机 realm 名**（持久化，重启不变）。部署后在 SSH / Web 终端里拿连接信息（`/home/zv` 换成你的 `SSH_USER` 家目录）：

```bash
cat /home/zv/p2p/client.example.yaml   # 一份填好的本地 client 配置，直接用
cat /home/zv/p2p/realm_name            # 仅 realm 名
cat /home/zv/p2p/cert_sha256           # 证书指纹 (pinSHA256)
```
启动日志也会打印含 realm 名 / Server URI / pinSHA256 的横幅。

#### ② 本地客户端怎么连（自签证书）
容器作为 hy2 server 用**自签证书**，指纹是容器内现生成的、事先不知道。`client.example.yaml` 已自动填好 `tls.insecure: true` + `tls.pinSHA256`（锁死指纹防 MITM）。把它拿到本地当 `client.yaml`，用官方 hysteria 客户端启动即可：本地 SOCKS5 `127.0.0.1:1080`、HTTP `127.0.0.1:8080`。

#### ③ 自建牵线服务器
在一台**公网机器**上跑 [hysteria-realm-server](https://github.com/apernet/hysteria-realm-server)，把 `HYP2P_RV` 填成它的 URI：
```bash
git clone https://github.com/apernet/hysteria-realm-server.git && cd hysteria-realm-server
docker build -t hy-realm .
docker run -d --name hy-realm --restart unless-stopped -p 8443:8443 \
  -e HYSTERIA_REALM_TOKEN="你的token" -e HYSTERIA_REALM_LISTEN=":8443" hy-realm
# 放行防火墙 TCP 8443
```
> ⚠️ **`realm://` 还是 `realm+http://`？必看**：上面这样跑**没配 TLS**，`HYP2P_RV` 必须用 **`realm+http://你的token@IP:8443/名字`**；用 `realm://`（HTTPS）会握手失败！只有给牵线服务器配了 TLS（域名+证书或 Caddy 反代自动签）才用 `realm://`。公共 `realm.hy2.io` 是 HTTPS，故用 `realm://`（留空即自动）。

#### ⚠️ 两个前提
*   **持久化**：realm 名与证书指纹存在 `$HOME/p2p`。**Koyeb 等无持久盘平台**重启会重新生成 → 本地 client 需重抄。想稳定就挂持久卷，或显式设 `HYP2P_RV`（固定 realm 名）+ 本地只用 `insecure: true`（不 pin 指纹）。
*   **NAT 类型**：UDP 打洞有硬限制 —— 只要**一端对称 NAT（随机端口）**且另一端非公网IP/全锥型，就**打不通**。公共 `realm.hy2.io` 为免费 best-effort，可能宕机/被墙。

---

## 🛠️ 运维与管理

1.  **流量监控 `gb`**: 开启 `GB=true` 后，在终端输入 `gb` 即可查看双显流量统计。
2.  **进程管理 `sctl`**: 内置 `sctl` (supervisorctl)，可随时查看或重启服务：
    ```bash
    sctl status        # 查看所有进程
    sctl restart kpal  # 重启保活模块
    ```
3.  **配置持久化**: 镜像启动后会在挂载目录下生成 `init_env.sh` (初始化脚本) 和 `boot/supervisord.conf` (服务配置)。修改后执行 `sctl update` 即可。

---

## 🏁 流程总结
1. **选方法**：使用 Docker 命令行或平台环境变量面板。
2. **设变量**：配置 SSH、KPAL、CF 等核心变量。
3. **挂存储**：确保挂载路径与用户名一致。
4. **收工**：部署成功后，使用 `gb` 查流量，使用 `sctl` 管进程。

---

**🤝 鸣谢**
本项目参考了 `vevc/ubuntu` 的设计思路，并针对持久化挂载、流量统计、灵活保活机制进行了深度定制。
