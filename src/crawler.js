import axios from 'axios';
import https from 'https';
import crypto from 'crypto';

const BASE_URL = 'https://a21772.pweb.kr';
const LOGIN_ID = '관리실';
const LOGIN_PW = 'qwer1234!!';

// SHA256 해시 함수
function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// SSL 인증서 검증 비활성화 (자체 서명 인증서 대응)
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

let cookies = '';
let client = null;

// 쿠키 파싱 및 저장
function parseCookies(response) {
  const setCookies = response.headers['set-cookie'];
  if (setCookies) {
    const newCookies = setCookies.map(cookie => cookie.split(';')[0]).join('; ');
    if (cookies) {
      cookies = cookies + '; ' + newCookies;
    } else {
      cookies = newCookies;
    }
  }
}

// 로그인 및 세션 획득
export async function login() {
  cookies = '';
  client = axios.create({
    baseURL: BASE_URL,
    httpsAgent,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  try {
    // 먼저 로그인 페이지 접근해서 세션 초기화
    const initResponse = await client.get('/login');
    parseCookies(initResponse);

    // 로그인 수행 (비밀번호는 SHA256 해시)
    const loginResponse = await client.post('/login', {
      userId: LOGIN_ID,
      userPwd: sha256(LOGIN_PW)
    }, {
      headers: {
        Cookie: cookies,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'amano_http_ajax': 'true',
        'ajax': 'true'
      }
    });
    parseCookies(loginResponse);

    // 로그인 실패 체크 (errorCode가 있으면 실패)
    if (loginResponse.data && loginResponse.data.errorCode) {
      console.error('로그인 실패:', loginResponse.data.errorMsg);
      return false;
    }

    console.log('로그인 성공');
    return true;
  } catch (error) {
    console.error('로그인 실패:', error.message);
    return false;
  }
}

// 날짜 범위로 차량 이동 내역 가져오기
export async function fetchMovements(startDate, endDate) {
  if (!client || !cookies) {
    const loggedIn = await login();
    if (!loggedIn) {
      throw new Error('로그인 실패');
    }
  }

  try {
    const params = new URLSearchParams();
    params.append('searchStartDt', `${startDate} 00:00:00`);
    params.append('searchEndDt', `${endDate} 23:59:59`);
    params.append('iInOutStatus', '');
    params.append('iCardType', '');
    params.append('acPlate', '');
    params.append('rowcount', '50000');

    const response = await client.post('/search/lprtrns/doListGrid', params, {
      headers: {
        Cookie: cookies,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
      }
    });

    if (!response.data || typeof response.data === 'string') {
      // HTML이 반환되면 세션 만료로 판단
      if (typeof response.data === 'string' && response.data.includes('login')) {
        console.log('세션 만료, 재로그인 시도...');
        cookies = '';
        client = null;
        await login();
        return fetchMovements(startDate, endDate);
      }
      return [];
    }

    return parseMovements(response.data);
  } catch (error) {
    console.error('데이터 조회 실패:', error.message);
    throw error;
  }
}

// API 응답 파싱
function parseMovements(data) {
  const movements = [];

  // 응답이 배열인 경우
  let items = [];
  if (Array.isArray(data)) {
    items = data;
  } else if (data.rows) {
    items = data.rows;
  } else if (data.list) {
    items = data.list;
  } else if (data.data) {
    items = Array.isArray(data.data) ? data.data : [data.data];
  }

  for (const item of items) {
    try {
      // 실제 API 응답 필드에 맞춤
      // dtTrnsDate: "2025-12-22 17:31:21.0" -> 밀리초 제거
      let movementTime = item.dtTrnsDate || '';
      if (movementTime && movementTime.includes('.')) {
        movementTime = movementTime.split('.')[0];
      }

      const movement = {
        plateNumber: item.acPlate || '',
        movementType: parseMovementType(item.iInOutStatus),
        movementTime: movementTime,
        location: item.acEqpmName || '',  // 장비 이름 (RF IN LPR(상행) 등)
        cardType: item.iCardTypeNm || '',  // 일반차량 등
        rawData: item
      };

      if (movement.plateNumber && movement.movementTime) {
        movements.push(movement);
      }
    } catch (e) {
      console.error('데이터 파싱 오류:', e.message);
    }
  }

  return movements;
}

// iInOutStatus: "0" = 입차, "1" = 출차
function parseMovementType(status) {
  const statusStr = String(status);
  if (statusStr === '0') {
    return '입차';
  }
  if (statusStr === '1') {
    return '출차';
  }
  // 문자열로 된 경우 처리
  if (statusStr.includes('입') || statusStr.toLowerCase().includes('in')) {
    return '입차';
  }
  if (statusStr.includes('출') || statusStr.toLowerCase().includes('out')) {
    return '출차';
  }
  return status || '알수없음';
}

// 오늘 날짜 문자열 반환
export function getTodayString() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 날짜 범위 생성 (startDate ~ endDate)
export function getDateRange(startDate, endDate) {
  const dates = [];
  const current = new Date(startDate);
  const end = new Date(endDate);

  while (current <= end) {
    const year = current.getFullYear();
    const month = String(current.getMonth() + 1).padStart(2, '0');
    const day = String(current.getDate()).padStart(2, '0');
    dates.push(`${year}-${month}-${day}`);
    current.setDate(current.getDate() + 1);
  }

  return dates;
}
