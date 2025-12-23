import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import {
  getStats,
  getParkedVehicles,
  getParkingCountByLocation,
  getVehicleHistory,
  getMovementsByDateRange,
  getDb,
  getLastUpdateTime
} from './database.js';
import { runCrawlJob, startScheduler } from './scheduler.js';
import {
  getRestorationStatusByCarNum,
  getRestorationStatusForVehicles,
  categorizeStatus,
  getRestorationTasks,
  getCurrentTasksForVehicles,
  getTaskStatistics,
  getRestorationNosForVehicles
} from './cpm-database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_ID = process.env.ADMIN_ID || 'admin';
const ADMIN_PW = process.env.ADMIN_PW || 'admin1234';

// SQLite 세션 스토어
class SQLiteStore extends session.Store {
  constructor(dbPath) {
    super();
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired INTEGER NOT NULL
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired)`);

    // 만료된 세션 정리 (1시간마다)
    setInterval(() => this.clearExpired(), 60 * 60 * 1000);
    this.clearExpired();
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?').get(sid, Date.now());
      callback(null, row ? JSON.parse(row.sess) : null);
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      const maxAge = sess.cookie?.maxAge || 86400000;
      const expired = Date.now() + maxAge;
      this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)').run(sid, JSON.stringify(sess), expired);
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }

  destroy(sid, callback) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }

  clearExpired() {
    try {
      this.db.prepare('DELETE FROM sessions WHERE expired <= ?').run(Date.now());
    } catch (err) {
      console.error('세션 정리 오류:', err.message);
    }
  }
}

// 미들웨어 설정
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  store: new SQLiteStore('./parking.db'),
  secret: process.env.SESSION_SECRET || 'hwasung-parking-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30일
  }
}));

// 인증 미들웨어
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  res.redirect('/login');
}

// 로그인 페이지
app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  res.send(getLoginPage());
});

// 로그인 처리
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_ID && password === ADMIN_PW) {
    req.session.authenticated = true;
    req.session.username = username;
    res.redirect('/');
  } else {
    res.send(getLoginPage('아이디 또는 비밀번호가 일치하지 않습니다.'));
  }
});

// 로그아웃
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// 메인 대시보드
app.get('/', requireAuth, async (req, res) => {
  const stats = getStats();
  const allParkedVehicles = getParkedVehicles();

  // 상품화 상태 조회
  const allPlateNumbers = allParkedVehicles.map(v => v.plate_number);
  const restorationMap = await getRestorationStatusForVehicles(allPlateNumbers);

  // 전산등록 차량만 필터 (restoration 정보가 있는 차량)
  const parkedVehicles = allParkedVehicles.filter(v => {
    const restoration = restorationMap.get(v.plate_number);
    return restoration && restoration.statusCode !== null;
  });
  const plateNumbers = parkedVehicles.map(v => v.plate_number);

  // 전산 미등록 차량
  const unregisteredVehicles = allParkedVehicles.filter(v => {
    const restoration = restorationMap.get(v.plate_number);
    return !restoration || restoration.statusCode === null;
  });

  // 위치별 현황 재계산 (전산등록 차량만)
  const locationCounts = {};
  for (const v of parkedVehicles) {
    const loc = v.location || '미지정';
    locationCounts[loc] = (locationCounts[loc] || 0) + 1;
  }
  const locations = Object.entries(locationCounts)
    .map(([location, count]) => ({ location, count }))
    .sort((a, b) => b.count - a.count);

  // 장기 주차 차량 (3일/5일/7일 이상)
  const parked3days = parkedVehicles.filter(v => v.parking_hours >= 72);
  const parked5days = parkedVehicles.filter(v => v.parking_hours >= 120);
  const parked7days = parkedVehicles.filter(v => v.parking_hours >= 168);

  // stats 업데이트 (전산등록 차량 수)
  stats.currentlyParked = parkedVehicles.length;

  // 위치별 상품화 통계 계산 (전산등록 차량만)
  const locationStats = {};
  for (const vehicle of parkedVehicles) {
    const loc = vehicle.location || '미지정';
    if (!locationStats[loc]) {
      locationStats[loc] = {
        total: 0,
        working: 0,           // 작업중
        completed: 0,         // 작업완료
        outbound_waiting: 0,  // 출고대기
        pending: 0,           // 입고/대기
        done: 0,              // 출고완료
        fail: 0               // 출고검수 FAIL
      };
    }
    locationStats[loc].total++;

    const restoration = restorationMap.get(vehicle.plate_number);
    if (restoration) {
      // FAIL 여부 먼저 체크 - FAIL이면 fail에만 카운트
      if (restoration.hasFail) {
        locationStats[loc].fail++;
      } else {
        const category = categorizeStatus(restoration.statusCode);
        if (locationStats[loc][category] !== undefined) {
          locationStats[loc][category]++;
        }
      }
    }
  }

  // 전체 상품화 통계 (전산등록 차량만)
  const totalRestorationStats = {
    working: 0,
    completed: 0,
    outbound_waiting: 0,
    pending: 0,
    done: 0,
    fail: 0
  };
  for (const loc of Object.values(locationStats)) {
    totalRestorationStats.working += loc.working;
    totalRestorationStats.completed += loc.completed;
    totalRestorationStats.outbound_waiting += loc.outbound_waiting;
    totalRestorationStats.pending += loc.pending;
    totalRestorationStats.done += loc.done;
    totalRestorationStats.fail += loc.fail;
  }

  // 입차 차량들의 restoration r_no 조회 후 작업별 통계 조회
  const rNos = await getRestorationNosForVehicles(plateNumbers);
  const taskStats = await getTaskStatistics(rNos);

  // 마지막 업데이트 시간
  const lastUpdateTime = getLastUpdateTime();

  res.send(getDashboardPage(stats, locations, parkedVehicles.slice(0, 20), { parked3days, parked5days, parked7days }, locationStats, totalRestorationStats, taskStats, lastUpdateTime, unregisteredVehicles));
});


// 특정 위치의 차량 목록
app.get('/location/:name', requireAuth, async (req, res) => {
  const locationName = decodeURIComponent(req.params.name);
  const allParkedVehicles = getParkedVehicles();
  const allVehiclesAtLocation = allParkedVehicles.filter(v =>
    (v.location || '미지정') === locationName
  );
  const allPlateNumbers = allVehiclesAtLocation.map(v => v.plate_number);
  const restorationMap = await getRestorationStatusForVehicles(allPlateNumbers);

  // 전산등록 차량만 필터
  const vehiclesAtLocation = allVehiclesAtLocation.filter(v => {
    const restoration = restorationMap.get(v.plate_number);
    return restoration && restoration.statusCode !== null;
  });
  const plateNumbers = vehiclesAtLocation.map(v => v.plate_number);
  const currentTasksMap = await getCurrentTasksForVehicles(plateNumbers);
  res.send(getLocationDetailPage(locationName, vehiclesAtLocation, restorationMap, currentTasksMap));
});

// 상품화 상태별 차량 목록
app.get('/status/:category', requireAuth, async (req, res) => {
  const category = req.params.category;
  const categoryNames = {
    pending: '입고/대기',
    working: '작업중',
    completed: '작업완료',
    outbound_waiting: '출고대기',
    done: '출고완료',
    fail: '검수 NG'
  };
  const categoryName = categoryNames[category] || category;

  const allParkedVehicles = getParkedVehicles();
  const allPlateNumbers = allParkedVehicles.map(v => v.plate_number);
  const restorationMap = await getRestorationStatusForVehicles(allPlateNumbers);

  // 해당 카테고리에 맞는 차량만 필터
  const filteredVehicles = allParkedVehicles.filter(v => {
    const restoration = restorationMap.get(v.plate_number);
    if (!restoration || restoration.statusCode === null) return false;

    if (category === 'fail') {
      return restoration.hasFail;
    }
    return !restoration.hasFail && restoration.category === category;
  });

  res.send(getStatusPage(category, categoryName, filteredVehicles, restorationMap));
});

// 현재 입차 차량 목록 (전산등록 차량만)
app.get('/parked', requireAuth, async (req, res) => {
  const allParkedVehicles = getParkedVehicles();
  const allPlateNumbers = allParkedVehicles.map(v => v.plate_number);
  const restorationMap = await getRestorationStatusForVehicles(allPlateNumbers);

  // 전산등록 차량만 필터
  const parkedVehicles = allParkedVehicles.filter(v => {
    const restoration = restorationMap.get(v.plate_number);
    return restoration && restoration.statusCode !== null;
  });
  const plateNumbers = parkedVehicles.map(v => v.plate_number);
  const currentTasksMap = await getCurrentTasksForVehicles(plateNumbers);
  res.send(getParkedPage(parkedVehicles, restorationMap, currentTasksMap));
});

// 장기 주차 차량 목록 (전산등록 차량만, 3일/5일/7일 이상)
app.get('/long-parked/:days', requireAuth, async (req, res) => {
  const days = parseInt(req.params.days);
  const hours = days * 24;
  const allParkedVehicles = getParkedVehicles();
  const allLongParked = allParkedVehicles.filter(v => v.parking_hours >= hours);
  const allPlateNumbers = allLongParked.map(v => v.plate_number);
  const restorationMap = await getRestorationStatusForVehicles(allPlateNumbers);

  // 전산등록 차량만 필터
  const longParked = allLongParked.filter(v => {
    const restoration = restorationMap.get(v.plate_number);
    return restoration && restoration.statusCode !== null;
  });
  const plateNumbers = longParked.map(v => v.plate_number);
  const currentTasksMap = await getCurrentTasksForVehicles(plateNumbers);
  res.send(getLongParkedPage(days, longParked, restorationMap, currentTasksMap));
});

// 차량 상세 이력
app.get('/vehicle/:plate', requireAuth, async (req, res) => {
  const plate = decodeURIComponent(req.params.plate);
  const history = getVehicleHistory(plate);
  const parkedVehicles = getParkedVehicles();
  const currentStatus = parkedVehicles.find(v => v.plate_number === plate);

  // 상품화 상태 조회
  const restorationInfo = await getRestorationStatusByCarNum(plate);

  // 작업 타임라인 조회
  let tasks = [];
  if (restorationInfo.restoration) {
    tasks = await getRestorationTasks(restorationInfo.restoration.r_no);
  }

  res.send(getVehicleDetailPage(plate, history, currentStatus, restorationInfo, tasks));
});

// 차량 검색 API
app.get('/api/search', requireAuth, (req, res) => {
  const { plate } = req.query;
  if (!plate) {
    return res.json({ error: '차량번호를 입력하세요' });
  }

  const db = getDb();
  const stmt = db.prepare(`
    SELECT DISTINCT plate_number FROM vehicle_movements
    WHERE plate_number LIKE ?
    ORDER BY plate_number
    LIMIT 20
  `);
  const results = stmt.all(`%${plate}%`);
  res.json(results);
});

// 수동 크롤링 트리거
app.post('/api/crawl', requireAuth, async (req, res) => {
  try {
    await runCrawlJob();
    res.json({ success: true, message: '크롤링 완료' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// 통계 API
app.get('/api/stats', requireAuth, (req, res) => {
  const stats = getStats();
  const locations = getParkingCountByLocation();
  res.json({ stats, locations });
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`화성 주차 관제 시스템 웹 서버 시작: http://localhost:${PORT}`);
  console.log(`로그인 ID: ${ADMIN_ID}`);

  // 1분마다 오늘 날짜 크롤링 스케줄러 시작
  startScheduler('*/1 * * * *');
});

// ========== HTML 템플릿 함수들 ==========

// 주차시간 human readable 포맷
function formatParkingDuration(hours) {
  const days = Math.floor(hours / 24);
  const remainingHours = Math.floor(hours % 24);
  const mins = Math.round((hours % 1) * 60);
  if (days > 0) {
    return `${days}일 ${remainingHours}시간`;
  }
  return `${remainingHours}시간 ${mins}분`;
}

// 전산 미등록 차량 HTML 생성
function getUnregisteredVehiclesHtml(vehicles) {
  if (!vehicles || vehicles.length === 0) return '';

  return `
    <div class="stat-card" style="background: linear-gradient(135deg, #616161 0%, #9e9e9e 100%);">
      <div class="stat-value">${vehicles.length}</div>
      <div class="stat-label">전산 미등록</div>
    </div>
  `;
}

function getBaseStyles() {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f7fa;
      color: #333;
    }
    .navbar {
      background: linear-gradient(135deg, #1a237e 0%, #283593 100%);
      color: white;
      padding: 1rem 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .navbar h1 { font-size: 1.5rem; font-weight: 600; }
    .navbar a { color: white; text-decoration: none; margin-left: 1.5rem; opacity: 0.9; }
    .navbar a:hover { opacity: 1; }
    .nav-links { display: flex; align-items: center; flex-wrap: wrap; }
    .container { max-width: 1400px; margin: 0 auto; padding: 2rem; }
    .card {
      background: white;
      border-radius: 12px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }
    .card h2 {
      font-size: 1.1rem;
      color: #1a237e;
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 2px solid #e8eaf6;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .stat-card {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 1.5rem;
      border-radius: 12px;
      text-align: center;
    }
    .stat-card.blue { background: linear-gradient(135deg, #1a237e 0%, #3949ab 100%); }
    .stat-card.green { background: linear-gradient(135deg, #00796b 0%, #26a69a 100%); }
    .stat-card.orange { background: linear-gradient(135deg, #ef6c00 0%, #ff9800 100%); }
    .stat-card.red { background: linear-gradient(135deg, #c62828 0%, #ef5350 100%); }
    .stat-card.purple { background: linear-gradient(135deg, #6a1b9a 0%, #9c27b0 100%); }
    .stat-value { font-size: 2rem; font-weight: 700; }
    .stat-label { font-size: 0.85rem; opacity: 0.9; margin-top: 0.5rem; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f8f9fa; font-weight: 600; color: #555; }
    tr:hover { background: #f8f9fa; }
    .badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 20px;
      font-size: 0.8rem;
      font-weight: 500;
    }
    .badge-in { background: #e8f5e9; color: #2e7d32; }
    .badge-out { background: #ffebee; color: #c62828; }
    .badge-long { background: #fff3e0; color: #ef6c00; }
    .badge-restoration { background: #e3f2fd; color: #1565c0; }
    .badge-cpo { background: #fce4ec; color: #c2185b; font-size: 0.7rem; padding: 0.2rem 0.5rem; }
    .badge-none { background: #f5f5f5; color: #757575; }
    .stat-pending { background: #e3f2fd; color: #1565c0; }
    .stat-working { background: #fff3e0; color: #ef6c00; }
    .stat-completed { background: #e8f5e9; color: #2e7d32; }
    .stat-outbound { background: #f3e5f5; color: #7b1fa2; }
    .stat-done { background: #ede7f6; color: #5e35b1; }
    .stat-fail { background: #ffebee; color: #c62828; }
    .stat-none { background: #f5f5f5; color: #757575; }
    .btn {
      display: inline-block;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      text-decoration: none;
      font-size: 0.9rem;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
    }
    .btn-primary { background: #1a237e; color: white; }
    .btn-primary:hover { background: #283593; }
    .btn-sm { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
    .search-box {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .search-box input {
      flex: 1;
      padding: 0.75rem;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 1rem;
    }
    .location-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1rem;
    }
    .location-card {
      background: white;
      border: 1px solid #e0e0e0;
      border-radius: 10px;
      padding: 1.25rem;
      transition: all 0.2s;
      cursor: pointer;
      text-decoration: none;
      color: inherit;
      display: block;
    }
    .location-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
      border-color: #1a237e;
    }
    .location-name { font-weight: 600; margin-bottom: 0.5rem; }
    .location-count { font-size: 2rem; font-weight: 700; color: #1a237e; }
    .progress-bar {
      height: 8px;
      background: #e0e0e0;
      border-radius: 4px;
      margin-top: 0.75rem;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #1a237e, #3949ab);
      border-radius: 4px;
    }
    .vehicle-info { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .info-item { padding: 1rem; background: #f8f9fa; border-radius: 8px; }
    .info-label { font-size: 0.85rem; color: #666; margin-bottom: 0.25rem; }
    .info-value { font-size: 1.1rem; font-weight: 600; color: #1a237e; word-break: break-all; }
    .timeline { position: relative; padding-left: 2rem; }
    .timeline::before {
      content: '';
      position: absolute;
      left: 0.5rem;
      top: 0;
      bottom: 0;
      width: 2px;
      background: #e0e0e0;
    }
    .timeline-item {
      position: relative;
      padding: 1rem 0;
      border-bottom: 1px solid #f0f0f0;
    }
    .timeline-item::before {
      content: '';
      position: absolute;
      left: -1.5rem;
      top: 1.25rem;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #1a237e;
      border: 2px solid white;
      box-shadow: 0 0 0 2px #1a237e;
    }
    .timeline-item.out::before { background: #c62828; box-shadow: 0 0 0 2px #c62828; }
    .restoration-card {
      background: linear-gradient(135deg, #e3f2fd 0%, #bbdefb 100%);
      border: 2px solid #1565c0;
      padding: 1.5rem;
      border-radius: 12px;
      margin-bottom: 1.5rem;
    }
    .restoration-status {
      font-size: 1.5rem;
      font-weight: 700;
      color: #1565c0;
    }
    .two-col-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    .table-responsive { overflow-x: auto; -webkit-overflow-scrolling: touch; }

    /* 모바일 반응형 스타일 */
    @media (max-width: 768px) {
      .navbar {
        padding: 0.75rem 1rem;
        flex-direction: column;
        align-items: flex-start;
      }
      .navbar h1 { font-size: 1.2rem; margin-bottom: 0.5rem; }
      .nav-links {
        width: 100%;
        justify-content: flex-start;
        gap: 0.5rem;
      }
      .navbar a { margin-left: 0; margin-right: 1rem; font-size: 0.9rem; }
      .container { padding: 1rem; }
      .card { padding: 1rem; }
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      .stat-value { font-size: 1.5rem; }
      .stat-label { font-size: 0.75rem; }
      .stat-card { padding: 1rem; }
      .two-col-grid { grid-template-columns: 1fr; }
      .location-grid { grid-template-columns: 1fr; }
      table { font-size: 0.85rem; }
      th, td { padding: 0.5rem 0.4rem; }
      .btn-sm { padding: 0.25rem 0.5rem; font-size: 0.75rem; }
      .vehicle-info { grid-template-columns: 1fr 1fr; }
      .info-value { font-size: 1rem; }
      .timeline { padding-left: 1.5rem; }
      .restoration-status { font-size: 1.2rem; }
    }

    @media (max-width: 480px) {
      .stats-grid { grid-template-columns: 1fr 1fr; gap: 0.5rem; }
      .stat-card { padding: 0.75rem; }
      .stat-value { font-size: 1.3rem; }
      .navbar h1 { font-size: 1rem; }
      .search-box { flex-direction: column; }
      .search-box input { width: 100%; }
      .search-box button { width: 100%; }
      .card h2 { font-size: 1rem; }
    }
  `;
}

function getLoginPage(error = '') {
  return `
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>로그인 - 화성 주차 관제 시스템</title>
  <style>
    ${getBaseStyles()}
    .login-container {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #1a237e 0%, #283593 100%);
    }
    .login-box {
      background: white;
      padding: 3rem;
      border-radius: 16px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      width: 100%;
      max-width: 400px;
    }
    .login-title {
      text-align: center;
      margin-bottom: 2rem;
    }
    .login-title h1 { color: #1a237e; font-size: 1.5rem; }
    .login-title p { color: #666; margin-top: 0.5rem; }
    .form-group { margin-bottom: 1.25rem; }
    .form-group label { display: block; margin-bottom: 0.5rem; font-weight: 500; }
    .form-group input {
      width: 100%;
      padding: 0.875rem;
      border: 1px solid #ddd;
      border-radius: 8px;
      font-size: 1rem;
    }
    .form-group input:focus { outline: none; border-color: #1a237e; }
    .login-btn {
      width: 100%;
      padding: 1rem;
      background: #1a237e;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .login-btn:hover { background: #283593; }
    .error-msg {
      background: #ffebee;
      color: #c62828;
      padding: 0.75rem;
      border-radius: 6px;
      margin-bottom: 1rem;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="login-box">
      <div class="login-title">
        <h1>화성 주차 관제 시스템</h1>
        <p>관리자 로그인</p>
      </div>
      ${error ? `<div class="error-msg">${error}</div>` : ''}
      <form method="POST" action="/login">
        <div class="form-group">
          <label for="username">아이디</label>
          <input type="text" id="username" name="username" required placeholder="아이디를 입력하세요">
        </div>
        <div class="form-group">
          <label for="password">비밀번호</label>
          <input type="password" id="password" name="password" required placeholder="비밀번호를 입력하세요">
        </div>
        <button type="submit" class="login-btn">로그인</button>
      </form>
    </div>
  </div>
</body>
</html>
  `;
}

function getDashboardPage(stats, locations, recentParked, longParkedStats, locationStats = {}, totalRestorationStats = {}, taskStats = {}, lastUpdateTime = null, unregisteredVehicles = []) {
  const totalLocations = locations.reduce((sum, l) => sum + l.count, 0);
  const { parked3days = [], parked5days = [], parked7days = [] } = longParkedStats || {};
  const lastUpdateDisplay = lastUpdateTime ? new Date(lastUpdateTime + 'Z').toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-';

  // 작업별 통계 HTML 생성 (현재 작업중인 것만)
  const totalTasking = Object.values(taskStats).reduce((s, c) => s + c, 0);
  const taskStatsHtml = totalTasking > 0 ? `
    <div class="card">
      <h2>현재 작업중 (총 ${totalTasking}건)</h2>
      <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));">
        ${Object.entries(taskStats).map(([part, count]) => `
          <div class="stat-card" style="background: linear-gradient(135deg, #ef6c00 0%, #ff9800 100%);">
            <div class="stat-value">${count}</div>
            <div class="stat-label">${part}</div>
          </div>
        `).join('')}
      </div>
    </div>
  ` : '';

  return `
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>대시보드 - 화성 주차 관제 시스템</title>
  <style>
    ${getBaseStyles()}
    .restoration-stats {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      margin-top: 0.5rem;
    }
    .restoration-stat {
      font-size: 0.75rem;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-weight: 500;
    }
    .stat-working { background: #fff3e0; color: #ef6c00; }
    .stat-completed { background: #e8f5e9; color: #2e7d32; }
    .stat-pending { background: #e3f2fd; color: #1565c0; }
    .stat-outbound { background: #f3e5f5; color: #7b1fa2; }
    .stat-done { background: #ede7f6; color: #5e35b1; }
    .stat-fail { background: #ffebee; color: #c62828; }
    .stat-none { background: #f5f5f5; color: #757575; }
  </style>
</head>
<body>
  <nav class="navbar">
    <a href="/" style="text-decoration:none;color:inherit;"><h1>화성 주차 관제 시스템</h1></a>
    <div class="nav-links">
      <a href="/">대시보드</a>
      <a href="/parked">입차 차량</a>
      <a href="/logout">로그아웃</a>
    </div>
  </nav>

  <div class="container">
    <div style="text-align:right; margin-bottom:0.75rem; color:#666; font-size:0.85rem;">
      마지막 업데이트: ${lastUpdateDisplay}
    </div>

    <div class="stats-grid">
      <div class="stat-card green">
        <div class="stat-value">${stats.currentlyParked.toLocaleString()}</div>
        <div class="stat-label">현재 입차 중</div>
      </div>
      <a href="/long-parked/3" class="stat-card" style="background: linear-gradient(135deg, #f57c00 0%, #ffb74d 100%); text-decoration:none; color:white;">
        <div class="stat-value">${parked3days.length}</div>
        <div class="stat-label">3일+ 장기주차</div>
      </a>
      <a href="/long-parked/5" class="stat-card" style="background: linear-gradient(135deg, #e65100 0%, #ff9800 100%); text-decoration:none; color:white;">
        <div class="stat-value">${parked5days.length}</div>
        <div class="stat-label">5일+ 장기주차</div>
      </a>
      <a href="/long-parked/7" class="stat-card red" style="text-decoration:none; color:white;">
        <div class="stat-value">${parked7days.length}</div>
        <div class="stat-label">7일+ 장기주차</div>
      </a>
      ${getUnregisteredVehiclesHtml(unregisteredVehicles)}
    </div>

    <div class="card">
      <h2>상품화 현황 (전산등록 차량)</h2>
      <div class="stats-grid">
        <a href="/status/pending" class="stat-card" style="background: linear-gradient(135deg, #1565c0 0%, #42a5f5 100%); text-decoration:none; color:white;">
          <div class="stat-value">${totalRestorationStats.pending || 0}</div>
          <div class="stat-label">입고/대기</div>
        </a>
        <a href="/status/working" class="stat-card" style="background: linear-gradient(135deg, #ef6c00 0%, #ff9800 100%); text-decoration:none; color:white;">
          <div class="stat-value">${totalRestorationStats.working || 0}</div>
          <div class="stat-label">작업중</div>
        </a>
        <a href="/status/completed" class="stat-card" style="background: linear-gradient(135deg, #2e7d32 0%, #4caf50 100%); text-decoration:none; color:white;">
          <div class="stat-value">${totalRestorationStats.completed || 0}</div>
          <div class="stat-label">작업완료</div>
        </a>
        <a href="/status/outbound_waiting" class="stat-card" style="background: linear-gradient(135deg, #7b1fa2 0%, #ab47bc 100%); text-decoration:none; color:white;">
          <div class="stat-value">${totalRestorationStats.outbound_waiting || 0}</div>
          <div class="stat-label">출고대기</div>
        </a>
        <a href="/status/done" class="stat-card" style="background: linear-gradient(135deg, #5e35b1 0%, #7e57c2 100%); text-decoration:none; color:white;">
          <div class="stat-value">${totalRestorationStats.done || 0}</div>
          <div class="stat-label">출고완료</div>
        </a>
        <a href="/status/fail" class="stat-card" style="background: linear-gradient(135deg, #c62828 0%, #ef5350 100%); text-decoration:none; color:white;">
          <div class="stat-value">${totalRestorationStats.fail || 0}</div>
          <div class="stat-label">검수 NG</div>
        </a>
      </div>
    </div>

    <div class="card">
      <h2>차량 검색</h2>
      <div class="search-box">
        <input type="text" id="searchInput" placeholder="차량번호 입력 (예: 12가3456)">
        <button class="btn btn-primary" onclick="searchVehicle()">검색</button>
      </div>
      <div id="searchResults"></div>
    </div>

    <div class="card">
      <h2>위치별 현황 (총 ${totalLocations}대)</h2>
      <div class="location-grid">
        ${(() => {
          const maxCount = Math.max(...locations.map(l => l.count));
          return locations.map(loc => {
            const locStat = locationStats[loc.location] || {};
            const percentage = totalLocations > 0 ? (loc.count / totalLocations * 100).toFixed(1) : 0;
            return `
            <a href="/location/${encodeURIComponent(loc.location)}" class="location-card">
              <div class="location-name">${loc.location}</div>
              <div class="location-count">${loc.count}<span style="font-size:1rem;font-weight:normal;">대</span></div>
              <div class="progress-bar">
                <div class="progress-fill" style="width: ${(loc.count / maxCount * 100)}%"></div>
              </div>
              <div style="margin-top:0.5rem; font-size:0.85rem; color:#666;">전체의 ${percentage}%</div>
              <div class="restoration-stats" style="margin-top:0.5rem;">
                ${locStat.pending ? `<span class="restoration-stat stat-pending">입고/대기 ${locStat.pending}</span>` : ''}
                ${locStat.working ? `<span class="restoration-stat stat-working">작업중 ${locStat.working}</span>` : ''}
                ${locStat.completed ? `<span class="restoration-stat stat-completed">작업완료 ${locStat.completed}</span>` : ''}
                ${locStat.outbound_waiting ? `<span class="restoration-stat stat-outbound">출고대기 ${locStat.outbound_waiting}</span>` : ''}
                ${locStat.done ? `<span class="restoration-stat stat-done">출고완료 ${locStat.done}</span>` : ''}
                ${locStat.fail ? `<span class="restoration-stat stat-fail">검수 NG ${locStat.fail}</span>` : ''}
              </div>
            </a>
          `;}).join('');
        })()}
      </div>
    </div>

    ${taskStatsHtml}

    ${recentParked.length > 0 ? `
    <div class="card">
      <h2>최근 입차 차량</h2>
      <div class="table-responsive">
        <table>
          <thead>
            <tr><th>차량번호</th><th>입차시각</th><th>주차시간</th><th>위치</th><th>상세</th></tr>
          </thead>
          <tbody>
            ${recentParked.map(v => {
              const isLong = v.parking_hours >= 72;
              return `
              <tr>
                <td><strong>${v.plate_number}</strong></td>
                <td>${v.entry_time}</td>
                <td><span class="badge ${isLong ? 'badge-long' : 'badge-in'}">${formatParkingDuration(v.parking_hours)}</span></td>
                <td>${v.location || '-'}</td>
                <td><a href="/vehicle/${encodeURIComponent(v.plate_number)}" class="btn btn-primary btn-sm">상세</a></td>
              </tr>
            `;}).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ` : ''}

  </div>

  <script>
    function searchVehicle() {
      const plate = document.getElementById('searchInput').value.trim();
      if (!plate) return;

      fetch('/api/search?plate=' + encodeURIComponent(plate))
        .then(res => res.json())
        .then(data => {
          const results = document.getElementById('searchResults');
          if (data.length === 0) {
            results.innerHTML = '<p style="color:#666; padding:1rem;">검색 결과가 없습니다.</p>';
          } else {
            results.innerHTML = '<div style="padding:0.5rem;">' +
              data.map(v => '<a href="/vehicle/' + encodeURIComponent(v.plate_number) +
                '" class="btn btn-primary btn-sm" style="margin:0.25rem;">' + v.plate_number + '</a>').join('') +
              '</div>';
          }
        });
    }

    document.getElementById('searchInput').addEventListener('keypress', function(e) {
      if (e.key === 'Enter') searchVehicle();
    });
  </script>
</body>
</html>
  `;
}

function getStatusPage(category, categoryName, vehicles, restorationMap = new Map()) {
  const categoryColors = {
    pending: '#1565c0',
    working: '#ef6c00',
    completed: '#2e7d32',
    outbound_waiting: '#7b1fa2',
    done: '#5e35b1',
    fail: '#c62828'
  };
  const color = categoryColors[category] || '#666';

  return `
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${categoryName} 차량 - 화성 주차 관제 시스템</title>
  <style>
    ${getBaseStyles()}
  </style>
</head>
<body>
  <nav class="navbar">
    <a href="/" style="text-decoration:none;color:inherit;"><h1>화성 주차 관제 시스템</h1></a>
    <div class="nav-links">
      <a href="/">대시보드</a>
      <a href="/parked">입차 차량</a>
      <a href="/logout">로그아웃</a>
    </div>
  </nav>

  <div class="container">
    <div class="card" style="border-left: 4px solid ${color};">
      <h2 style="color:${color};">${categoryName} (${vehicles.length}대)</h2>
      <p style="margin-bottom:1rem;"><a href="/">← 대시보드로 돌아가기</a></p>
      <table>
        <thead>
          <tr><th>차량번호</th><th>입차시각</th><th>주차시간</th><th>위치</th><th>상세</th></tr>
        </thead>
        <tbody>
          ${vehicles.length === 0 ? `
          <tr><td colspan="5" style="text-align:center; padding:2rem; color:#666;">${categoryName} 차량이 없습니다.</td></tr>
          ` : vehicles.map(v => {
            const isLong = v.parking_hours >= 72;
            const restoration = restorationMap.get(v.plate_number);
            const cpoType = restoration ? restoration.cpoType : null;
            return `
            <tr>
              <td>
                <strong>${v.plate_number}</strong>
                ${cpoType ? `<span class="badge badge-cpo" style="margin-left:0.5rem;">${cpoType}</span>` : ''}
              </td>
              <td>${v.entry_time}</td>
              <td><span class="badge ${isLong ? 'badge-long' : 'badge-in'}">${formatParkingDuration(v.parking_hours)}</span></td>
              <td>${v.location || '-'}</td>
              <td><a href="/vehicle/${encodeURIComponent(v.plate_number)}" class="btn btn-primary btn-sm">상세</a></td>
            </tr>
          `;}).join('')}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>
  `;
}

function getLocationDetailPage(locationName, vehicles, restorationMap = new Map(), currentTasksMap = new Map()) {
  return `
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${locationName} - 화성 주차 관제 시스템</title>
  <style>
    ${getBaseStyles()}
    .current-tasks { display: flex; flex-wrap: wrap; gap: 0.25rem; margin-top: 0.25rem; }
    .task-chip { font-size: 0.7rem; padding: 0.15rem 0.4rem; background: #fff3e0; color: #ef6c00; border-radius: 3px; }
  </style>
</head>
<body>
  <nav class="navbar">
    <a href="/" style="text-decoration:none;color:inherit;"><h1>화성 주차 관제 시스템</h1></a>
    <div class="nav-links">
      <a href="/">대시보드</a>
      <a href="/parked">입차 차량</a>
      <a href="/logout">로그아웃</a>
    </div>
  </nav>

  <div class="container">
    <div class="card">
      <h2>${locationName} (${vehicles.length}대)</h2>
      <p style="margin-bottom:1rem;"><a href="/">← 대시보드로 돌아가기</a></p>
      <table>
        <thead>
          <tr><th>차량번호</th><th>입차시각</th><th>주차시간</th><th>상품화 상태</th><th>상세</th></tr>
        </thead>
        <tbody>
          ${vehicles.map(v => {
            const isLong = v.parking_hours >= 72;
            const restoration = restorationMap.get(v.plate_number);
            const categoryText = restoration ? restoration.categoryText : '전산 미등록';
            const category = restoration ? restoration.category : 'none';
            const statusClass = restoration ? (restoration.hasFail ? 'stat-fail' : `stat-${category === 'outbound_waiting' ? 'outbound' : category}`) : 'badge-none';
            const cpoType = restoration ? restoration.cpoType : null;
            return `
            <tr>
              <td><strong>${v.plate_number}</strong></td>
              <td>${v.entry_time}</td>
              <td><span class="badge ${isLong ? 'badge-long' : 'badge-in'}">${formatParkingDuration(v.parking_hours)}</span></td>
              <td>
                <span class="badge ${statusClass}">${categoryText}</span>
                ${cpoType ? `<span class="badge badge-cpo" style="margin-left:0.5rem;">${cpoType}</span>` : ''}
              </td>
              <td><a href="/vehicle/${encodeURIComponent(v.plate_number)}" class="btn btn-primary btn-sm">상세</a></td>
            </tr>
          `;}).join('')}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>
  `;
}

function getParkedPage(vehicles, restorationMap = new Map(), currentTasksMap = new Map()) {
  return `
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>입차 차량 - 화성 주차 관제 시스템</title>
  <style>
    ${getBaseStyles()}
    .current-tasks { display: flex; flex-wrap: wrap; gap: 0.25rem; margin-top: 0.25rem; }
    .task-chip { font-size: 0.7rem; padding: 0.15rem 0.4rem; background: #fff3e0; color: #ef6c00; border-radius: 3px; }
  </style>
</head>
<body>
  <nav class="navbar">
    <a href="/" style="text-decoration:none;color:inherit;"><h1>화성 주차 관제 시스템</h1></a>
    <div class="nav-links">
      <a href="/">대시보드</a>
      <a href="/parked">입차 차량</a>
      <a href="/logout">로그아웃</a>
    </div>
  </nav>

  <div class="container">
    <div class="card">
      <h2>현재 입차 중인 차량 (${vehicles.length}대)</h2>
      <div class="table-responsive">
        <table>
          <thead>
            <tr><th>차량번호</th><th>입차시각</th><th>주차시간</th><th>위치</th><th>상품화 상태</th><th>상세</th></tr>
          </thead>
          <tbody>
            ${vehicles.map(v => {
              const isLong = v.parking_hours >= 72;
              const restoration = restorationMap.get(v.plate_number);
              const categoryText = restoration ? restoration.categoryText : '전산 미등록';
              const category = restoration ? restoration.category : 'none';
              const statusClass = restoration ? (restoration.hasFail ? 'stat-fail' : `stat-${category === 'outbound_waiting' ? 'outbound' : category}`) : 'badge-none';
              const cpoType = restoration ? restoration.cpoType : null;
              return `
              <tr>
                <td><strong>${v.plate_number}</strong></td>
                <td>${v.entry_time}</td>
                <td><span class="badge ${isLong ? 'badge-long' : 'badge-in'}">${formatParkingDuration(v.parking_hours)}</span></td>
                <td>${v.location || '-'}</td>
                <td>
                  <span class="badge ${statusClass}">${categoryText}</span>
                  ${cpoType ? `<span class="badge badge-cpo" style="margin-left:0.5rem;">${cpoType}</span>` : ''}
                </td>
                <td><a href="/vehicle/${encodeURIComponent(v.plate_number)}" class="btn btn-primary btn-sm">상세</a></td>
              </tr>
            `;}).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </div>
</body>
</html>
  `;
}

function getVehicleDetailPage(plate, history, currentStatus, restorationInfo = null, tasks = []) {
  const totalVisits = history.filter(h => h.movement_type === '입차').length;
  const lastEntry = history.find(h => h.movement_type === '입차');
  const lastExit = history.find(h => h.movement_type === '출차');

  // 작업별로 그룹화
  const tasksByPart = {};
  for (const task of tasks) {
    const part = task.work_part_name || '기타';
    if (!tasksByPart[part]) {
      tasksByPart[part] = [];
    }
    tasksByPart[part].push(task);
  }

  // 최근 이미지 URL 추출 (raw_data에서)
  let imageUrl = null;
  for (const h of history) {
    if (h.raw_data) {
      try {
        const rawData = JSON.parse(h.raw_data);
        if (rawData.acImgFilePath) {
          imageUrl = rawData.acImgFilePath;
          break;
        }
      } catch (e) {}
    }
  }

  // 상품화 상태 배지 색상 결정
  const getRestorationBadgeClass = (statusCode) => {
    if (!statusCode) return 'badge-none';
    const workingStatuses = ['WORKING', 'WORK_PENDING'];
    const completedStatuses = ['SERVICE_COMPLETED', 'OUTBOUND_COMPLETED'];
    const pendingStatuses = ['RECEPTION_COMPLETED', 'INBOUND_PENDING', 'INBOUND_COMPLETED'];
    if (completedStatuses.includes(statusCode)) return 'badge-in';
    if (workingStatuses.includes(statusCode)) return 'badge-long';
    if (pendingStatuses.includes(statusCode)) return 'badge-out';
    return 'badge-restoration';
  };

  return `
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${plate} - 차량 상세</title>
  <style>
    ${getBaseStyles()}
    .vehicle-image {
      max-width: 100%;
      border-radius: 8px;
      margin-top: 1rem;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .image-container {
      text-align: center;
      margin-bottom: 1.5rem;
    }
    .restoration-badge {
      display: inline-block;
      padding: 0.5rem 1rem;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      margin-top: 0.5rem;
    }
    .task-section { margin-bottom: 1.5rem; }
    .task-section h3 { font-size: 1rem; color: #1a237e; margin-bottom: 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid #e0e0e0; }
    .task-list { display: flex; flex-direction: column; gap: 0.5rem; }
    .task-item {
      display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem;
      padding: 0.75rem; background: #f8f9fa; border-radius: 8px; border-left: 4px solid #9e9e9e;
    }
    .task-item.tasking { border-left-color: #ef6c00; background: #fff3e0; }
    .task-item.complete { border-left-color: #2e7d32; background: #e8f5e9; }
    .task-item.pending { border-left-color: #1565c0; background: #e3f2fd; }
    .task-item.fail { border-left-color: #c62828; background: #ffebee; }
    .task-name { font-weight: 500; }
    .task-group { font-size: 0.85rem; color: #666; }
    .task-status { font-size: 0.8rem; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 500; }
  </style>
</head>
<body>
  <nav class="navbar">
    <a href="/" style="text-decoration:none;color:inherit;"><h1>화성 주차 관제 시스템</h1></a>
    <div class="nav-links">
      <a href="/">대시보드</a>
      <a href="/parked">입차 차량</a>
      <a href="/logout">로그아웃</a>
    </div>
  </nav>

  <div class="container">
    <div class="card">
      <h2>차량 정보</h2>
      <p style="margin-bottom:1rem;"><a href="javascript:history.back()">← 뒤로가기</a></p>

      <div style="text-align:center; padding:2rem; background:#f8f9fa; border-radius:12px; margin-bottom:1.5rem;">
        <div style="font-size:2rem; font-weight:700; color:#1a237e;">${plate}</div>
        <div style="margin-top:0.5rem;">
          ${currentStatus ?
            `<span class="badge badge-in" style="font-size:1rem; padding:0.5rem 1rem;">현재 입차 중</span>` :
            `<span class="badge badge-out" style="font-size:1rem; padding:0.5rem 1rem;">출차 완료</span>`
          }
          ${restorationInfo && restorationInfo.restoration && restorationInfo.restoration.cpoType ? `<span class="badge badge-cpo" style="font-size:0.9rem; padding:0.4rem 0.8rem; margin-left:0.5rem;">${restorationInfo.restoration.cpoType}</span>` : ''}
        </div>
        ${imageUrl ? `
        <div class="image-container">
          <img src="${imageUrl}" alt="차량 이미지" class="vehicle-image" onerror="this.style.display='none'">
        </div>
        ` : ''}
      </div>

      ${restorationInfo ? `
      <div class="restoration-card" ${restorationInfo.hasFail ? 'style="border-color:#c62828; background:linear-gradient(135deg, #ffebee 0%, #ffcdd2 100%);"' : ''}>
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem;">
          <div>
            <div style="font-size:0.9rem; color:${restorationInfo.hasFail ? '#c62828' : '#1565c0'}; margin-bottom:0.25rem;">상품화 상태</div>
            <div class="restoration-status" style="${restorationInfo.hasFail ? 'color:#c62828;' : ''}">
              ${restorationInfo.statusText}${restorationInfo.hasFail ? ' (NG)' : ''}
            </div>
          </div>
          <span class="badge ${restorationInfo.hasFail ? 'badge-out' : getRestorationBadgeClass(restorationInfo.statusCode)}" style="font-size:0.9rem; padding:0.5rem 1rem;">
            ${restorationInfo.found ? (restorationInfo.restoration ? (restorationInfo.hasFail ? '출고검수 NG' : restorationInfo.statusCode) : '상품화 정보 없음') : '전산 미등록'}
          </span>
        </div>
      </div>

      ${restorationInfo.car ? `
      <div class="card" style="margin-top:1rem;">
        <h2>전산 정보</h2>
        <div class="vehicle-info">
          <div class="info-item">
            <div class="info-label">제조사</div>
            <div class="info-value">${restorationInfo.car.brand_name || '-'}</div>
          </div>
          <div class="info-item">
            <div class="info-label">대표모델</div>
            <div class="info-value">${restorationInfo.car.model_init_name || '-'}</div>
          </div>
          <div class="info-item">
            <div class="info-label">모델</div>
            <div class="info-value">${restorationInfo.car.model_name || '-'}</div>
          </div>
          <div class="info-item">
            <div class="info-label">등급</div>
            <div class="info-value">${restorationInfo.car.series_name || '-'}</div>
          </div>
          <div class="info-item">
            <div class="info-label">연식</div>
            <div class="info-value">${restorationInfo.car.c_year ? restorationInfo.car.c_year + '년' : '-'}</div>
          </div>
          <div class="info-item">
            <div class="info-label">주행거리</div>
            <div class="info-value">${restorationInfo.car.c_mileage ? restorationInfo.car.c_mileage.toLocaleString() + 'km' : '-'}</div>
          </div>
          <div class="info-item">
            <div class="info-label">차대번호</div>
            <div class="info-value" style="font-size:0.85rem;">${restorationInfo.car.c_vin || '-'}</div>
          </div>
          <div class="info-item">
            <div class="info-label">차량 ID</div>
            <div class="info-value">${restorationInfo.car.c_no || '-'}</div>
          </div>
        </div>
      </div>
      ` : ''}
      ` : ''}

      <div class="vehicle-info">
        <div class="info-item">
          <div class="info-label">총 방문 횟수</div>
          <div class="info-value">${totalVisits}회</div>
        </div>
        <div class="info-item">
          <div class="info-label">전체 기록</div>
          <div class="info-value">${history.length}건</div>
        </div>
        ${currentStatus ? `
        <div class="info-item">
          <div class="info-label">현재 주차 시간</div>
          <div class="info-value">${formatParkingDuration(currentStatus.parking_hours)}</div>
        </div>
        <div class="info-item">
          <div class="info-label">현재 위치</div>
          <div class="info-value">${currentStatus.location || '미지정'}</div>
        </div>
        ` : `
        <div class="info-item">
          <div class="info-label">마지막 입차</div>
          <div class="info-value">${lastEntry ? lastEntry.movement_time : '-'}</div>
        </div>
        <div class="info-item">
          <div class="info-label">마지막 출차</div>
          <div class="info-value">${lastExit ? lastExit.movement_time : '-'}</div>
        </div>
        `}
      </div>
    </div>

    ${tasks.length > 0 ? `
    <div class="card">
      <h2>작업 현황 (${tasks.length}건)</h2>
      ${Object.entries(tasksByPart).map(([part, partTasks]) => `
        <div class="task-section">
          <h3>${part} (${partTasks.length}건)</h3>
          <div class="task-list">
            ${partTasks.map(task => {
              // 신/구 시스템 상태 코드 지원
              const isWorking = ['TASKING', 'DOING'].includes(task.rt_status_cd);
              const isComplete = ['TASK_COMPLETE', 'COMPLETE'].includes(task.rt_status_cd);
              const isPending = ['TASK_PENDING', 'ON_QUEUE', 'WAIT'].includes(task.rt_status_cd);
              const isNg = task.rt_status_cd === 'NG' || task.outboundInspectionResult === 'FAIL';
              const statusClass = isWorking ? 'tasking' :
                                 isComplete ? 'complete' :
                                 isPending ? 'pending' :
                                 isNg ? 'fail' : '';
              const statusBg = isWorking ? 'background:#fff3e0;color:#ef6c00;' :
                              isComplete ? 'background:#e8f5e9;color:#2e7d32;' :
                              isPending ? 'background:#e3f2fd;color:#1565c0;' :
                              isNg ? 'background:#ffebee;color:#c62828;' :
                              task.rt_status_cd === 'TASK_EXCLUDE' ? 'background:#f5f5f5;color:#757575;' :
                              'background:#f5f5f5;color:#757575;';
              return `
              <div class="task-item ${statusClass}">
                <div>
                  <div class="task-name">${task.work_name || task.work_group_name || '-'}</div>
                  ${task.work_group_name && task.work_name ? `<div class="task-group">${task.work_group_name}</div>` : ''}
                </div>
                <div style="display:flex; gap:0.5rem; align-items:center;">
                  ${task.outboundInspectionResult ? `
                    <span class="task-status" style="${task.outboundInspectionResult === 'FAIL' ? 'background:#ffebee;color:#c62828;' : 'background:#e8f5e9;color:#2e7d32;'}">
                      검수: ${task.outboundInspectionResult === 'FAIL' ? 'NG' : 'OK'}
                    </span>
                  ` : ''}
                  <span class="task-status" style="${statusBg}">${task.statusText}</span>
                </div>
              </div>
            `;}).join('')}
          </div>
        </div>
      `).join('')}
    </div>
    ` : ''}

    <div class="card">
      <h2>이동 이력 (최근 ${Math.min(history.length, 50)}건)</h2>
      <div class="timeline">
        ${history.slice(0, 50).map(h => {
          let historyImage = null;
          if (h.raw_data) {
            try {
              const rawData = JSON.parse(h.raw_data);
              historyImage = rawData.acImgFilePath;
            } catch (e) {}
          }
          return `
          <div class="timeline-item ${h.movement_type === '출차' ? 'out' : ''}">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
              <div>
                <span class="badge ${h.movement_type === '입차' ? 'badge-in' : 'badge-out'}">${h.movement_type}</span>
                <strong style="margin-left:0.5rem;">${h.movement_time}</strong>
              </div>
              <div style="color:#666; font-size:0.9rem;">${h.location || '-'}</div>
            </div>
            ${h.card_type ? `<div style="margin-top:0.5rem; font-size:0.85rem; color:#888;">차량유형: ${h.card_type}</div>` : ''}
            ${historyImage ? `<div style="margin-top:0.5rem;"><img src="${historyImage}" alt="이동 시점 이미지" style="max-width:200px; border-radius:4px; cursor:pointer;" onclick="window.open('${historyImage}', '_blank')" onerror="this.style.display='none'"></div>` : ''}
          </div>
        `;}).join('')}
      </div>
    </div>
  </div>
</body>
</html>
  `;
}

function getLongParkedPage(days, vehicles, restorationMap = new Map(), currentTasksMap = new Map()) {
  return `
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${days}일 이상 장기주차 - 화성 주차 관제 시스템</title>
  <style>
    ${getBaseStyles()}
    .current-tasks { display: flex; flex-wrap: wrap; gap: 0.25rem; margin-top: 0.25rem; }
    .task-chip { font-size: 0.7rem; padding: 0.15rem 0.4rem; background: #fff3e0; color: #ef6c00; border-radius: 3px; }
  </style>
</head>
<body>
  <nav class="navbar">
    <a href="/" style="text-decoration:none;color:inherit;"><h1>화성 주차 관제 시스템</h1></a>
    <div class="nav-links">
      <a href="/">대시보드</a>
      <a href="/parked">입차 차량</a>
      <a href="/logout">로그아웃</a>
    </div>
  </nav>

  <div class="container">
    <div class="card">
      <h2>${days}일 이상 장기주차 차량 (${vehicles.length}대)</h2>
      <p style="margin-bottom:1rem;"><a href="/">← 대시보드로 돌아가기</a></p>

      <div class="stats-grid" style="margin-bottom:1.5rem;">
        <a href="/long-parked/3" class="stat-card ${days === 3 ? 'orange' : ''}" style="text-decoration:none; color:white; ${days !== 3 ? 'background:linear-gradient(135deg,#90a4ae 0%,#b0bec5 100%);' : ''}">
          <div class="stat-label">3일+</div>
        </a>
        <a href="/long-parked/5" class="stat-card ${days === 5 ? 'orange' : ''}" style="text-decoration:none; color:white; ${days !== 5 ? 'background:linear-gradient(135deg,#90a4ae 0%,#b0bec5 100%);' : ''}">
          <div class="stat-label">5일+</div>
        </a>
        <a href="/long-parked/7" class="stat-card ${days === 7 ? 'red' : ''}" style="text-decoration:none; color:white; ${days !== 7 ? 'background:linear-gradient(135deg,#90a4ae 0%,#b0bec5 100%);' : ''}">
          <div class="stat-label">7일+</div>
        </a>
      </div>

      <div class="table-responsive">
        <table>
          <thead>
            <tr><th>차량번호</th><th>입차시각</th><th>주차시간</th><th>위치</th><th>상품화 상태</th><th>상세</th></tr>
          </thead>
          <tbody>
            ${vehicles.length === 0 ? `
            <tr><td colspan="6" style="text-align:center; padding:2rem; color:#666;">${days}일 이상 장기주차 차량이 없습니다.</td></tr>
            ` : vehicles.map(v => {
              const restoration = restorationMap.get(v.plate_number);
              const categoryText = restoration ? restoration.categoryText : '전산 미등록';
              const category = restoration ? restoration.category : 'none';
              const statusClass = restoration ? (restoration.hasFail ? 'stat-fail' : `stat-${category === 'outbound_waiting' ? 'outbound' : category}`) : 'badge-none';
              const cpoType = restoration ? restoration.cpoType : null;
              return `
              <tr>
                <td><strong>${v.plate_number}</strong></td>
                <td>${v.entry_time}</td>
                <td><span class="badge badge-long">${formatParkingDuration(v.parking_hours)}</span></td>
                <td>${v.location || '-'}</td>
                <td>
                  <span class="badge ${statusClass}">${categoryText}</span>
                  ${cpoType ? `<span class="badge badge-cpo" style="margin-left:0.5rem;">${cpoType}</span>` : ''}
                </td>
                <td><a href="/vehicle/${encodeURIComponent(v.plate_number)}" class="btn btn-primary btn-sm">상세</a></td>
              </tr>
            `;}).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </div>
</body>
</html>
  `;
}
