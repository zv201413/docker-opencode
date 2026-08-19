#!/usr/bin/env bash
set -e

# ==========================================
# 1. 变量解析与规范化 (支持小写优先，兼容大写)
# ==========================================
USER_NAME=${user:-${SSH_USER:-zv}}
USER_PWD=${pwd:-${SSH_PWD:-105106}}

DATA_DIR=${data_dir:-${DATA_DIR:-/data}}

OC_MODE=${oc_mode:-${OPENCODE_MODE:-web}}
OC_PORT=${oc_port:-${OPENCODE_PORT:-4096}}
OC_MODEL=${oc_model:-${OPENCODE_MODEL:-}}
OC_ARGS=${oc_args:-${OPENCODE_ARGS:-}}

ET_NAME=${et_name:-${EASYTIER_NAME:-}}
ET_SECRET=${et_secret:-${EASYTIER_SECRET:-}}
ET_IP=${et_ip:-${EASYTIER_IP:-}}
ET_PEERS=${et_peers:-${EASYTIER_PEERS:-}}
ET_ARGS=${et_args:-${EASYTIER_ARGS:-}}

TTYD_PORT=${ttyd_port:-${TTYD_PORT:-7681}}
TTYD_AUTH=${ttyd_auth:-${TTYD_AUTH:-}}

CF_TOKEN=${cf_token:-${CF_TOKEN:-}}

# ==========================================
# 2. 用户与权限初始化
# ==========================================
echo "👤 当前用户: $USER_NAME"

if [ "$USER_NAME" = "root" ]; then
    USER_HOME="/root"
else
    USER_HOME="/home/$USER_NAME"
    if ! id -u "$USER_NAME" >/dev/null 2>&1; then
        useradd -m -s /bin/bash "$USER_NAME" || true
    fi
fi

echo "root:$USER_PWD" | chpasswd
[ "$USER_NAME" != "root" ] && echo "$USER_NAME:$USER_PWD" | chpasswd
echo "$USER_NAME ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/init-users

# ==========================================
# 3. 自定义持久化目录挂载 (Data Dir)
# ==========================================
echo "💾 数据持久化目录: $DATA_DIR"
mkdir -p "$DATA_DIR/workspace"
mkdir -p "$DATA_DIR/.config/opencode"
mkdir -p "$DATA_DIR/.local/share/opencode"
mkdir -p "$DATA_DIR/.local/state/opencode"
mkdir -p "$DATA_DIR/.ssh"

# 修正权限
chown -R "$USER_NAME":"$USER_NAME" "$DATA_DIR"

# 建立软链接到用户家目录（root 身份下 USER_HOME 即 /root，两种身份共用同一套逻辑）
# opencode 的数据分三处：.config 存配置，.local/share 存会话库(opencode.db)/凭据/tool-output，
# .local/state 存模型选择与 prompt 历史。三处都要链，否则容器重建会丢掉全部 AI 会话。
ln -sfn "$DATA_DIR/workspace" "$USER_HOME/workspace"
mkdir -p "$USER_HOME/.config" "$USER_HOME/.local/share" "$USER_HOME/.local/state"
ln -sfn "$DATA_DIR/.config/opencode" "$USER_HOME/.config/opencode"
ln -sfn "$DATA_DIR/.local/share/opencode" "$USER_HOME/.local/share/opencode"
ln -sfn "$DATA_DIR/.local/state/opencode" "$USER_HOME/.local/state/opencode"
ln -sfn "$DATA_DIR/.ssh" "$USER_HOME/.ssh"
chown -R "$USER_NAME":"$USER_NAME" \
    "$USER_HOME/workspace" "$USER_HOME/.config" "$USER_HOME/.local" "$USER_HOME/.ssh"

# ==========================================
# 4. Supervisor 服务配置生成
# ==========================================
BOOT_DIR="/tmp/boot"
SYS_CONF_DIR="$BOOT_DIR/system.conf.d"
BOOT_CONF="$BOOT_DIR/supervisord.conf"

mkdir -p "$SYS_CONF_DIR"
mkdir -p /etc/supervisor/conf.d

cp /usr/local/etc/supervisord.conf.template "$BOOT_CONF"
sed -i "s/{USER_NAME}/$USER_NAME/g" "$BOOT_CONF"
sed -i "s|{BOOT_DIR}|$BOOT_DIR|g" "$BOOT_CONF"

rm -f "$SYS_CONF_DIR"/*.conf

# --- SSH 服务 ---
cp /usr/local/etc/fragments/sshd.conf "$SYS_CONF_DIR/"

# --- OpenCode 服务 ---
if [ "$OC_MODE" != "off" ]; then
    echo "🚀 启用 OpenCode ($OC_MODE 模式) 端口: $OC_PORT"
    cp /usr/local/etc/fragments/opencode.conf "$SYS_CONF_DIR/"
    sed -i "s/{OC_MODE}/$OC_MODE/g" "$SYS_CONF_DIR/opencode.conf"
    sed -i "s/{OC_PORT}/$OC_PORT/g" "$SYS_CONF_DIR/opencode.conf"
    sed -i "s|{OC_DIR}|$DATA_DIR/workspace|g" "$SYS_CONF_DIR/opencode.conf"
    sed -i "s/{USER_NAME}/$USER_NAME/g" "$SYS_CONF_DIR/opencode.conf"
    sed -i "s|{USER_HOME}|$USER_HOME|g" "$SYS_CONF_DIR/opencode.conf"
    sed -i "s|{OC_ARGS}|$OC_ARGS|g" "$SYS_CONF_DIR/opencode.conf"

    # API Keys & Models 环境注入
    OC_ENV_EXTRA=""
    if [ -n "$OC_MODEL" ]; then OC_ENV_EXTRA="$OC_ENV_EXTRA,OPENCODE_MODEL=\"$OC_MODEL\""; fi
    
    # 自动识别并透传各种 API Key (直接读取通用环境变量名)
    _API_KEY=${api_key:-${OPENCODE_API_KEY:-}}
    _DEEPSEEK_KEY=${deepseek_key:-${DEEPSEEK_API_KEY:-}}
    _OPENAI_KEY=${openai_key:-${OPENAI_API_KEY:-}}
    _ANTHROPIC_KEY=${anthropic_key:-${ANTHROPIC_API_KEY:-}}
    _GEMINI_KEY=${gemini_key:-${GEMINI_API_KEY:-}}

    if [ -n "$_API_KEY" ]; then OC_ENV_EXTRA="$OC_ENV_EXTRA,OPENCODE_API_KEY=\"$_API_KEY\""; fi
    if [ -n "$_DEEPSEEK_KEY" ]; then OC_ENV_EXTRA="$OC_ENV_EXTRA,DEEPSEEK_API_KEY=\"$_DEEPSEEK_KEY\""; fi
    if [ -n "$_OPENAI_KEY" ]; then OC_ENV_EXTRA="$OC_ENV_EXTRA,OPENAI_API_KEY=\"$_OPENAI_KEY\""; fi
    if [ -n "$_ANTHROPIC_KEY" ]; then OC_ENV_EXTRA="$OC_ENV_EXTRA,ANTHROPIC_API_KEY=\"$_ANTHROPIC_KEY\""; fi
    if [ -n "$_GEMINI_KEY" ]; then OC_ENV_EXTRA="$OC_ENV_EXTRA,GEMINI_API_KEY=\"$_GEMINI_KEY\""; fi

    sed -i "s|{OC_ENV_EXTRA}|$OC_ENV_EXTRA|g" "$SYS_CONF_DIR/opencode.conf"
fi

# --- EasyTier 异地组网 ---
if [ -n "$ET_NAME" ]; then
    echo "🌐 启用 EasyTier 异地组网 (网络名: $ET_NAME)"
    cp /usr/local/etc/fragments/easytier.conf "$SYS_CONF_DIR/"
    sed -i "s/{ET_NAME}/$ET_NAME/g" "$SYS_CONF_DIR/easytier.conf"
    sed -i "s/{ET_SECRET}/$ET_SECRET/g" "$SYS_CONF_DIR/easytier.conf"
    
    ET_IPV4_ARG=""
    if [ -n "$ET_IP" ]; then ET_IPV4_ARG="--ipv4 $ET_IP"; fi
    sed -i "s|{ET_IPV4_ARG}|$ET_IPV4_ARG|g" "$SYS_CONF_DIR/easytier.conf"

    ET_PEERS_ARG=""
    if [ -n "$ET_PEERS" ]; then ET_PEERS_ARG="--peers $ET_PEERS"; fi
    sed -i "s|{ET_PEERS_ARG}|$ET_PEERS_ARG|g" "$SYS_CONF_DIR/easytier.conf"
    
    sed -i "s|{ET_ARGS}|$ET_ARGS|g" "$SYS_CONF_DIR/easytier.conf"
fi

# --- TTYD Web 终端 ---
if [ -n "$TTYD_PORT" ] && [ "$TTYD_PORT" != "0" ] && [ "$TTYD_PORT" != "off" ]; then
    echo "💻 启用 Web 终端 (端口: $TTYD_PORT)"
    cp /usr/local/etc/fragments/ttyd.conf "$SYS_CONF_DIR/"
    sed -i "s/{TTYD_PORT}/$TTYD_PORT/g" "$SYS_CONF_DIR/ttyd.conf"
    sed -i "s/{USER_NAME}/$USER_NAME/g" "$SYS_CONF_DIR/ttyd.conf"
    sed -i "s|{USER_HOME}|$USER_HOME|g" "$SYS_CONF_DIR/ttyd.conf"
    
    if [ -n "$TTYD_AUTH" ]; then
        sed -i "s|{TTYD_AUTH}|-c $TTYD_AUTH|g" "$SYS_CONF_DIR/ttyd.conf"
    else
        sed -i "s|{TTYD_AUTH}||g" "$SYS_CONF_DIR/ttyd.conf"
    fi
fi

# --- Cloudflare Tunnel ---
if [ -n "$CF_TOKEN" ]; then
    echo "☁️ 启用 Cloudflare Tunnel"
    cp /usr/local/etc/fragments/cloudflared.conf "$SYS_CONF_DIR/"
    sed -i "s/{CF_TOKEN}/$CF_TOKEN/g" "$SYS_CONF_DIR/cloudflared.conf"
fi

# ==========================================
# 5. 启动 Supervisor
# ==========================================
echo "✅ 配置生成完成，启动 Supervisor..."
exec /usr/bin/supervisord -n -c "$BOOT_CONF"
