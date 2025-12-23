# 화성 주차 관제 시스템

화성 주차장의 차량 입출차 현황을 실시간으로 모니터링하고, CPM(상품화 관리) 시스템과 연동하여 차량별 상품화 상태를 추적하는 웹 기반 관제 시스템입니다.

## 주요 기능

- **실시간 입출차 모니터링**: 주차장 LPR 시스템에서 차량 이동 데이터 수집
- **CPM 시스템 연동**: 차량별 상품화 상태 조회 및 표시
- **대시보드**: 현재 입차 현황, 상품화 상태별 통계, 위치별 현황
- **상태별 차량 조회**: 입고/대기, 작업중, 작업완료, 출고대기, 출고완료, 검수 NG
- **장기주차 관리**: 3일/5일/7일 이상 장기 주차 차량 추적
- **차량 상세 이력**: 개별 차량의 입출차 이력 및 작업 현황 조회

## 상품화 상태 분류

| 상태 | 설명 | 색상 |
|------|------|------|
| 입고/대기 | 접수완료, 입고대기, 입고완료, 입고검수 등 | 파란색 |
| 작업중 | 작업대기, 작업중 | 주황색 |
| 작업완료 | 작업완료, 출고검수완료 | 초록색 |
| 출고대기 | 출고요청, 출고대기 | 보라색 |
| 출고완료 | 출고완료, 서비스완료 | 진한 보라색 |
| 검수 NG | 출고검수 불합격 | 빨간색 |

## 설치

```bash
npm install
```

## 환경 설정

`.env` 파일을 생성하고 다음 환경 변수를 설정합니다:

```env
# 주차장 API
PARKING_API_URL=https://your-parking-api.com
PARKING_API_KEY=your-api-key

# CPM 데이터베이스
CPM_DB_HOST=localhost
CPM_DB_PORT=3306
CPM_DB_USER=root
CPM_DB_PASSWORD=password
CPM_DB_NAME=cpm_dev

# 웹 서버
WEB_PORT=5555
SESSION_SECRET=your-session-secret

# 관리자 계정
ADMIN_USERNAME=admin
ADMIN_PASSWORD=password
```

## 실행

### 웹 서버 실행
```bash
npm run web
```
웹 대시보드가 `http://localhost:5555`에서 실행됩니다.

### 데이터 수집 스케줄러 실행
```bash
npm run scheduler
```
주기적으로 주차장 API에서 차량 이동 데이터를 수집합니다.

### 수동 데이터 수집
```bash
# 오늘 데이터 수집
npm run crawl

# 특정 기간 데이터 수집
npm run crawl:range -- --start 2024-01-01 --end 2024-01-31
```

### 현재 상태 확인
```bash
npm run status
```

## 프로젝트 구조

```
src/
├── index.js          # CLI 진입점
├── server.js         # Express 웹 서버
├── database.js       # SQLite 로컬 데이터베이스 (입출차 기록)
├── cpm-database.js   # MySQL CPM 시스템 연동
├── crawler.js        # 주차장 API 크롤러
└── scheduler.js      # 정기 데이터 수집 스케줄러
```

## Docker로 실행

### 빠른 시작

```bash
# .env 파일 설정
cp .env.example .env
# .env 파일 수정 후

# 컨테이너 빌드 및 실행
docker-compose up -d
```

웹 대시보드: `http://localhost:5555`

### 서비스 구성

| 서비스 | 설명 |
|--------|------|
| web | 웹 대시보드 서버 (포트 5555) |
| scheduler | 주차장 API 데이터 수집 스케줄러 |

### 명령어

```bash
# 컨테이너 시작
docker-compose up -d

# 로그 확인
docker-compose logs -f

# 컨테이너 중지
docker-compose down

# 재빌드
docker-compose up -d --build
```

## 기술 스택

- **Backend**: Node.js, Express
- **Database**: SQLite (로컬), MySQL (CPM 연동)
- **Frontend**: Server-side rendered HTML
- **Scheduler**: node-cron
- **Container**: Docker, Docker Compose
