FROM debian@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      xfce4 xfce4-terminal dbus-x11 tigervnc-standalone-server tigervnc-tools python3-websockify \
      chromium fonts-dejavu fonts-noto-cjk xdotool scrot \
      git curl ca-certificates python3 python3-pip nodejs npm ripgrep jq unzip less procps \
    && apt-get purge -y xfce4-screensaver light-locker 2>/dev/null; rm -rf /var/lib/apt/lists/*

RUN groupadd -g 1000 agent && useradd -m -u 1000 -g 1000 -s /bin/bash agent \
    && groupadd -g 1001 vnc && useradd -M -u 1001 -g 1001 -s /usr/sbin/nologin vnc \
    && mkdir -p /home/agent/workspace /home/agent/Desktop && chown -R agent:agent /home/agent

COPY hive-screen hive-session hive-shot /usr/local/bin/
RUN chmod 755 /usr/local/bin/hive-screen /usr/local/bin/hive-session /usr/local/bin/hive-shot

ENV DISPLAY=:1
USER agent
WORKDIR /home/agent/workspace
CMD ["sleep", "infinity"]
