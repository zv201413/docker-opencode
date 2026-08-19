FROM ubuntu:22.04

# 1. 基础环境设置
ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    user=zv \
    pwd=105106 \
    data_dir=/data

# 2. 安装基础依赖与开发工具链
RUN apt-get update && apt-get install -y \
    openssh-server supervisor curl wget sudo ca-certificates openssl \
    tzdata vim net-tools unzip iputils-ping telnet git iproute2 procps \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# 3. 安装核心业务工具
# 3a. cloudflared & ttyd
RUN curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb \
    && dpkg -i cloudflared.deb \
    && rm cloudflared.deb \
    && curl -L https://github.com/tsl0922/ttyd/releases/download/1.7.3/ttyd.x86_64 -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd

# 3b. opencode
RUN curl -fsSL https://opencode.ai/install | bash

# 3c. EasyTier
RUN curl -fsSL "https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/easytier-linux-x86_64-v2.6.4.zip" -o /tmp/easytier.zip \
    && unzip /tmp/easytier.zip -d /tmp/easytier \
    && mv /tmp/easytier/*/easytier-core /usr/local/bin/ \
    && mv /tmp/easytier/*/easytier-cli /usr/local/bin/ \
    && chmod +x /usr/local/bin/easytier-core /usr/local/bin/easytier-cli \
    && rm -rf /tmp/easytier*

# 4. SSH 环境预处理
RUN mkdir -p /run/sshd && ssh-keygen -A \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config
EXPOSE 7681 4096 22

# 5. 配置文件与脚本处理
RUN mkdir -p /usr/local/etc

# 拷贝包含占位符的配置文件
COPY supervisord.conf /usr/local/etc/supervisord.conf.template

# 拷贝独立片段模板
COPY fragments /usr/local/etc/fragments

# 拷贝动态处理逻辑的启动脚本
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 移除系统默认配置，确保只走持久化卷里的配置
RUN rm -f /etc/supervisor/supervisord.conf

# 6. 运行身份
USER root

# 执行 entrypoint.sh 进行动态替换和权限修正
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
