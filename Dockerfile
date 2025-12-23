FROM node:20-alpine

WORKDIR /app

# timezone 및 better-sqlite3 빌드를 위한 의존성 설치
RUN apk add --no-cache python3 make g++ tzdata

# 한국 시간대 설정
ENV TZ=Asia/Seoul
RUN cp /usr/share/zoneinfo/Asia/Seoul /etc/localtime && \
    echo "Asia/Seoul" > /etc/timezone

# 패키지 파일 복사 및 설치
COPY package*.json ./
RUN npm install --production

# 소스 코드 복사
COPY src/ ./src/

# 포트 노출
EXPOSE 5555

# 기본 명령어
CMD ["node", "src/server.js"]
