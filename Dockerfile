FROM node:20-alpine

WORKDIR /app

# better-sqlite3 빌드를 위한 의존성 설치
RUN apk add --no-cache python3 make g++

# 패키지 파일 복사 및 설치
COPY package*.json ./
RUN npm install --production

# 소스 코드 복사
COPY src/ ./src/

# 데이터 디렉토리 생성
RUN mkdir -p /app/data

# 포트 노출
EXPOSE 5555

# 기본 명령어
CMD ["node", "src/server.js"]
