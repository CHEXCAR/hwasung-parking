import 'dotenv/config';
import mysql from 'mysql2/promise';

// MySQL 연결 풀 생성
const pool = mysql.createPool({
  host: process.env.CPM_DB_HOST || 'localhost',
  port: parseInt(process.env.CPM_DB_PORT) || 3306,
  user: process.env.CPM_DB_USER || 'root',
  password: process.env.CPM_DB_PASSWORD || 'root',
  database: process.env.CPM_DB_NAME || 'cpm_dev',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// 상품화 상태 코드 매핑 (신/구 시스템 모두 지원)
const RESTORATION_STATUS = {
  // 신시스템
  'RECEPTION_COMPLETED': '접수완료',
  'INBOUND_PENDING': '입고대기',
  'INBOUND_COMPLETED': '입고완료',
  'INBOUND_INSPECTION_PENDING': '입고검수대기',
  'INBOUND_INSPECTION_COMPLETED': '입고검수완료',
  'WORK_PENDING': '작업대기',
  'WORKING': '작업중',
  'WORK_COMPLETED': '작업완료',
  'OUTBOUND_INSPECTION_COMPLETED': '출고검수완료',
  'OUTBOUND_IDLE': '출고요청',
  'OUTBOUND_PENDING': '출고대기',
  'OUTBOUND_COMPLETED': '출고완료',
  'SERVICE_COMPLETED': '서비스완료',
  // 구시스템
  'INPUT': '신청접수',
  'PICKUPING': '픽업중',
  'PICKUPOK': '픽업완료',
  'IN': '입고',
  'CHECK': '검수완료',
  'COMPLETE': '작업완료',
  'OUTREADY': '출고대기',
  'HOMESERVICE': '홈서비스',
  'UNPAY': '미결제',
  'FINISH': '종료'
};

/**
 * 차량번호로 차량 정보 조회 (기본 정보 포함)
 * @param {string} carNum - 차량번호
 * @returns {Promise<Object|null>} - 차량 정보 또는 null
 */
export async function getCarByNumber(carNum) {
  try {
    const [rows] = await pool.execute(
      `SELECT
        c.c_no, c.c_carnum, c.c_vin, c.c_year, c.c_mileage,
        c.c_first_date, c.c_displacement, c.c_gearbox_cd, c.c_fuel_cd,
        c.c_bm_no, c.c_boi_no, c.c_bo_no, c.c_bs_no,
        bm.bm_name as brand_name,
        boi.boi_name as model_init_name,
        bo.bo_name as model_name,
        bs.bs_name as series_name
      FROM car c
      LEFT JOIN basic_maker bm ON c.c_bm_no = bm.bm_no
      LEFT JOIN basic_model_init boi ON c.c_boi_no = boi.boi_no
      LEFT JOIN basic_model bo ON c.c_bo_no = bo.bo_no
      LEFT JOIN basic_series bs ON c.c_bs_no = bs.bs_no
      WHERE c.c_carnum = ? AND c.c_del_yn = 'N'
      ORDER BY c.c_no DESC
      LIMIT 1`,
      [carNum]
    );
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('차량 조회 오류:', error.message);
    return null;
  }
}

/**
 * 차량 ID로 상품화(restoration) 정보 조회
 * @param {number} carNo - car 테이블의 c_no
 * @returns {Promise<Object|null>} - 상품화 정보 또는 null
 */
export async function getRestorationByCarNo(carNo) {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM restoration WHERE r_c_no = ? ORDER BY r_no DESC LIMIT 1',
      [carNo]
    );
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('상품화 정보 조회 오류:', error.message);
    return null;
  }
}

/**
 * 차량번호로 상품화 상태 조회 (NG 여부 포함)
 * @param {string} carNum - 차량번호
 * @returns {Promise<Object>} - { found: boolean, car: Object, restoration: Object, statusText: string, hasFail: boolean }
 */
export async function getRestorationStatusByCarNum(carNum) {
  const result = {
    found: false,
    car: null,
    restoration: null,
    statusCode: null,
    statusText: '없음',
    hasFail: false
  };

  const car = await getCarByNumber(carNum);
  if (!car) {
    return result;
  }

  result.found = true;
  result.car = car;

  const restoration = await getRestorationByCarNo(car.c_no);
  if (!restoration) {
    result.statusText = '상품화 정보 없음';
    return result;
  }

  result.restoration = restoration;
  result.statusCode = restoration.r_status_cd;
  result.statusText = RESTORATION_STATUS[restoration.r_status_cd] || restoration.r_status_cd || '알 수 없음';

  // NG 여부 조회 (삭제된 작업 제외)
  try {
    const [failedTasks] = await pool.execute(
      `SELECT COUNT(*) as count FROM restoration_task
       WHERE rt_r_no = ? AND outboundInspectionResult = 'FAIL'
       AND (rt_cash_cd IS NULL OR rt_cash_cd != 'DELETE')`,
      [restoration.r_no]
    );
    result.hasFail = failedTasks[0].count > 0;
  } catch (error) {
    console.error('NG 조회 오류:', error.message);
  }

  return result;
}

/**
 * 상태 코드를 한글로 변환
 * @param {string} statusCode - 상태 코드
 * @returns {string} - 한글 상태명
 */
export function getStatusText(statusCode) {
  return RESTORATION_STATUS[statusCode] || statusCode || '알 수 없음';
}

/**
 * 여러 차량의 상품화 상태를 한번에 조회 (출고검수 결과 포함)
 * @param {Array<string>} carNums - 차량번호 배열
 * @returns {Promise<Map<string, Object>>} - 차량번호 -> 상품화 정보 맵
 */
export async function getRestorationStatusForVehicles(carNums) {
  const resultMap = new Map();

  if (!carNums || carNums.length === 0) {
    return resultMap;
  }

  try {
    // 차량번호로 car 테이블 조회 (삭제되지 않은 차량만, 차량번호별 최신 c_no만)
    const placeholders = carNums.map(() => '?').join(',');
    const [cars] = await pool.execute(
      `SELECT c_no, c_carnum FROM car
       WHERE c_carnum IN (${placeholders}) AND c_del_yn = 'N'
       AND c_no IN (
         SELECT MAX(c_no) FROM car
         WHERE c_carnum IN (${placeholders}) AND c_del_yn = 'N'
         GROUP BY c_carnum
       )`,
      [...carNums, ...carNums]
    );

    if (cars.length === 0) {
      return resultMap;
    }

    // car c_no 목록으로 restoration 조회
    const carNoToCarNum = new Map();
    const carNos = [];
    for (const car of cars) {
      carNoToCarNum.set(car.c_no, car.c_carnum);
      carNos.push(car.c_no);
    }

    const restorationPlaceholders = carNos.map(() => '?').join(',');

    // restoration 및 최신 r_no 조회
    const [restorations] = await pool.execute(
      `SELECT r_no, r_c_no, r_status_cd FROM restoration
       WHERE r_c_no IN (${restorationPlaceholders})
       AND r_no IN (
         SELECT MAX(r_no) FROM restoration
         WHERE r_c_no IN (${restorationPlaceholders})
         GROUP BY r_c_no
       )`,
      [...carNos, ...carNos]
    );

    // restoration r_no 목록으로 restoration_task에서 FAIL 여부 조회
    const rNoToCarNum = new Map();
    const rNos = [];
    for (const restoration of restorations) {
      const carNum = carNoToCarNum.get(restoration.r_c_no);
      if (carNum) {
        rNoToCarNum.set(restoration.r_no, carNum);
        rNos.push(restoration.r_no);
      }
    }

    // FAIL 작업이 있는 restoration 조회
    const failedRNos = new Set();
    if (rNos.length > 0) {
      const taskPlaceholders = rNos.map(() => '?').join(',');
      const [failedTasks] = await pool.execute(
        `SELECT DISTINCT rt_r_no FROM restoration_task
         WHERE rt_r_no IN (${taskPlaceholders})
         AND outboundInspectionResult = 'FAIL'
         AND (rt_cash_cd IS NULL OR rt_cash_cd != 'DELETE')`,
        rNos
      );
      for (const task of failedTasks) {
        failedRNos.add(task.rt_r_no);
      }
    }

    // 결과 맵 구성
    for (const restoration of restorations) {
      const carNum = carNoToCarNum.get(restoration.r_c_no);
      if (carNum) {
        const hasFail = failedRNos.has(restoration.r_no);
        const category = categorizeStatus(restoration.r_status_cd);
        resultMap.set(carNum, {
          statusCode: restoration.r_status_cd,
          statusText: RESTORATION_STATUS[restoration.r_status_cd] || restoration.r_status_cd || '알 수 없음',
          category: category,
          categoryText: hasFail ? '검수 NG' : (CATEGORY_TEXT[category] || '기타'),
          hasFail: hasFail
        });
      }
    }

    // car는 있지만 restoration이 없는 경우 처리
    for (const car of cars) {
      if (!resultMap.has(car.c_carnum)) {
        resultMap.set(car.c_carnum, {
          statusCode: null,
          statusText: '상품화 정보 없음',
          category: 'none',
          categoryText: '상품화 정보 없음',
          hasFail: false
        });
      }
    }

  } catch (error) {
    console.error('다중 차량 상품화 조회 오류:', error.message);
  }

  return resultMap;
}

/**
 * 상품화 상태를 카테고리로 분류 (신/구 시스템 모두 지원)
 * @param {string} statusCode - 상태 코드
 * @returns {string} - 카테고리 (working, completed, outbound_waiting, pending, done, none)
 */
export function categorizeStatus(statusCode) {
  if (!statusCode) return 'none';

  // 작업중 (신: WORKING, WORK_PENDING / 구: WORKING)
  if (['WORKING', 'WORK_PENDING'].includes(statusCode)) {
    return 'working';
  }
  // 작업완료 (신: WORK_COMPLETED, OUTBOUND_INSPECTION_COMPLETED / 구: COMPLETE)
  if (['WORK_COMPLETED', 'OUTBOUND_INSPECTION_COMPLETED', 'COMPLETE'].includes(statusCode)) {
    return 'completed';
  }
  // 출고대기 (신: OUTBOUND_IDLE, OUTBOUND_PENDING / 구: OUTREADY, HOMESERVICE, UNPAY)
  if (['OUTBOUND_IDLE', 'OUTBOUND_PENDING', 'OUTREADY', 'HOMESERVICE', 'UNPAY'].includes(statusCode)) {
    return 'outbound_waiting';
  }
  // 출고/서비스 완료 (신: OUTBOUND_COMPLETED, SERVICE_COMPLETED / 구: FINISH)
  if (['OUTBOUND_COMPLETED', 'SERVICE_COMPLETED', 'FINISH'].includes(statusCode)) {
    return 'done';
  }
  // 입고/대기 상태 (신: RECEPTION_COMPLETED ~ INBOUND_INSPECTION_COMPLETED / 구: INPUT, PICKUPING, PICKUPOK, IN, CHECK)
  if (['RECEPTION_COMPLETED', 'INBOUND_PENDING', 'INBOUND_COMPLETED', 'INBOUND_INSPECTION_PENDING', 'INBOUND_INSPECTION_COMPLETED',
       'INPUT', 'PICKUPING', 'PICKUPOK', 'IN', 'CHECK'].includes(statusCode)) {
    return 'pending';
  }

  return 'other';
}

// 카테고리를 통일된 텍스트로 변환
const CATEGORY_TEXT = {
  'pending': '입고/대기',
  'working': '작업중',
  'completed': '작업완료',
  'outbound_waiting': '출고대기',
  'done': '출고완료',
  'none': '전산 미등록',
  'other': '기타'
};

export function getCategoryText(statusCode) {
  const category = categorizeStatus(statusCode);
  return CATEGORY_TEXT[category] || '기타';
}

/**
 * MySQL 연결 테스트
 */
export async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('MySQL 연결 성공');
    connection.release();
    return true;
  } catch (error) {
    console.error('MySQL 연결 실패:', error.message);
    return false;
  }
}

// 작업 상태 코드 매핑 (신/구 시스템 모두 지원)
const TASK_STATUS = {
  // 신시스템
  'TASK_PENDING': '작업대기',
  'ON_QUEUE': '작업대기',
  'TASKING': '작업중',
  'TASK_COMPLETE': '작업완료',
  'TASK_EXCLUDE': '작업제외',
  // 구시스템
  'WAIT': '작업대기',
  'DOING': '작업중',
  'COMPLETE': '작업완료',
  'NG': '부적합'
};

/**
 * restoration_no로 모든 작업 조회 (작업부위, 작업그룹, 세부작업 정보 포함)
 * @param {number} rNo - restoration r_no
 * @returns {Promise<Array>} - 작업 목록
 */
export async function getRestorationTasks(rNo) {
  try {
    const [rows] = await pool.execute(
      `SELECT
        rt.rt_no,
        rt.rt_r_no,
        rt.rt_status_cd,
        rt.outboundInspectionResult,
        wp.wp_no,
        wp.wp_title as work_part_name,
        wg.wg_no,
        wg.wg_title as work_group_name,
        w.w_no,
        w.w_title as work_name,
        w.w_pos as work_position
      FROM restoration_task rt
      LEFT JOIN basic_work_part wp ON rt.rt_wp_no = wp.wp_no
      LEFT JOIN basic_work_group wg ON rt.rt_wg_no = wg.wg_no
      LEFT JOIN basic_work w ON rt.rt_w_no = w.w_no
      WHERE rt.rt_r_no = ?
      AND (rt.rt_cash_cd IS NULL OR rt.rt_cash_cd != 'DELETE')
      ORDER BY wp.wp_no, wg.wg_no, rt.rt_no`,
      [rNo]
    );

    return rows.map(row => ({
      ...row,
      statusText: TASK_STATUS[row.rt_status_cd] || row.rt_status_cd || '알 수 없음'
    }));
  } catch (error) {
    console.error('작업 목록 조회 오류:', error.message);
    return [];
  }
}

/**
 * 현재 입차 중인 차량들의 작업중(TASKING) 작업 조회
 * @param {Array<string>} carNums - 차량번호 배열
 * @returns {Promise<Map<string, Array>>} - 차량번호 -> 작업중인 작업 목록 맵
 */
export async function getCurrentTasksForVehicles(carNums) {
  const resultMap = new Map();

  if (!carNums || carNums.length === 0) {
    return resultMap;
  }

  try {
    // 차량번호별 최신 c_no만 조회
    const placeholders = carNums.map(() => '?').join(',');
    const [cars] = await pool.execute(
      `SELECT c_no, c_carnum FROM car
       WHERE c_carnum IN (${placeholders}) AND c_del_yn = 'N'
       AND c_no IN (
         SELECT MAX(c_no) FROM car
         WHERE c_carnum IN (${placeholders}) AND c_del_yn = 'N'
         GROUP BY c_carnum
       )`,
      [...carNums, ...carNums]
    );

    if (cars.length === 0) {
      return resultMap;
    }

    const carNoToCarNum = new Map();
    const carNos = [];
    for (const car of cars) {
      carNoToCarNum.set(car.c_no, car.c_carnum);
      carNos.push(car.c_no);
    }

    const restorationPlaceholders = carNos.map(() => '?').join(',');
    const [restorations] = await pool.execute(
      `SELECT r_no, r_c_no FROM restoration
       WHERE r_c_no IN (${restorationPlaceholders})
       AND r_no IN (
         SELECT MAX(r_no) FROM restoration
         WHERE r_c_no IN (${restorationPlaceholders})
         GROUP BY r_c_no
       )`,
      [...carNos, ...carNos]
    );

    if (restorations.length === 0) {
      return resultMap;
    }

    const rNoToCarNum = new Map();
    const rNos = [];
    for (const restoration of restorations) {
      const carNum = carNoToCarNum.get(restoration.r_c_no);
      if (carNum) {
        rNoToCarNum.set(restoration.r_no, carNum);
        rNos.push(restoration.r_no);
      }
    }

    // 작업중 상태인 작업 조회 (신/구 시스템 모두 지원)
    const taskPlaceholders = rNos.map(() => '?').join(',');
    const [tasks] = await pool.execute(
      `SELECT
        rt.rt_r_no,
        wp.wp_title as work_part_name,
        wg.wg_title as work_group_name,
        w.w_title as work_name
      FROM restoration_task rt
      LEFT JOIN basic_work_part wp ON rt.rt_wp_no = wp.wp_no
      LEFT JOIN basic_work_group wg ON rt.rt_wg_no = wg.wg_no
      LEFT JOIN basic_work w ON rt.rt_w_no = w.w_no
      WHERE rt.rt_r_no IN (${taskPlaceholders})
      AND rt.rt_status_cd IN ('TASKING', 'ON_QUEUE', 'DOING', 'WAIT')
      AND (rt.rt_cash_cd IS NULL OR rt.rt_cash_cd != 'DELETE')`,
      rNos
    );

    // 결과 매핑
    for (const task of tasks) {
      const carNum = rNoToCarNum.get(task.rt_r_no);
      if (carNum) {
        if (!resultMap.has(carNum)) {
          resultMap.set(carNum, []);
        }
        resultMap.get(carNum).push({
          workPart: task.work_part_name,
          workGroup: task.work_group_name,
          workName: task.work_name
        });
      }
    }

  } catch (error) {
    console.error('작업중 작업 조회 오류:', error.message);
  }

  return resultMap;
}

/**
 * 입차 중인 차량의 현재 작업중(TASKING) 작업 통계 조회 (작업부위별)
 * @param {Array<number>} rNos - restoration r_no 배열
 * @returns {Promise<Object>} - 작업부위별 작업중 수
 */
export async function getTaskStatistics(rNos = null) {
  try {
    if (!rNos || rNos.length === 0) {
      return {};
    }

    const placeholders = rNos.map(() => '?').join(',');
    const [rows] = await pool.execute(
      `SELECT
        wp.wp_title as work_part_name,
        COUNT(*) as count
      FROM restoration_task rt
      LEFT JOIN basic_work_part wp ON rt.rt_wp_no = wp.wp_no
      WHERE rt.rt_r_no IN (${placeholders})
      AND rt.rt_status_cd IN ('TASKING', 'ON_QUEUE', 'DOING', 'WAIT')
      AND (rt.rt_cash_cd IS NULL OR rt.rt_cash_cd != 'DELETE')
      GROUP BY wp.wp_title
      ORDER BY count DESC`,
      rNos
    );

    // 작업부위별로 집계
    const stats = {};
    for (const row of rows) {
      const part = row.work_part_name || '기타';
      stats[part] = row.count;
    }

    return stats;
  } catch (error) {
    console.error('작업 통계 조회 오류:', error.message);
    return {};
  }
}

/**
 * 입차 중인 차량들의 restoration r_no 목록 조회
 * @param {Array<string>} carNums - 차량번호 배열
 * @returns {Promise<Array<number>>} - r_no 배열
 */
export async function getRestorationNosForVehicles(carNums) {
  if (!carNums || carNums.length === 0) {
    return [];
  }

  try {
    // 차량번호별 최신 c_no만 조회
    const placeholders = carNums.map(() => '?').join(',');
    const [cars] = await pool.execute(
      `SELECT c_no FROM car
       WHERE c_carnum IN (${placeholders}) AND c_del_yn = 'N'
       AND c_no IN (
         SELECT MAX(c_no) FROM car
         WHERE c_carnum IN (${placeholders}) AND c_del_yn = 'N'
         GROUP BY c_carnum
       )`,
      [...carNums, ...carNums]
    );

    if (cars.length === 0) {
      return [];
    }

    const carNos = cars.map(c => c.c_no);
    const restorationPlaceholders = carNos.map(() => '?').join(',');
    const [restorations] = await pool.execute(
      `SELECT r_no FROM restoration
       WHERE r_c_no IN (${restorationPlaceholders})
       AND r_no IN (
         SELECT MAX(r_no) FROM restoration
         WHERE r_c_no IN (${restorationPlaceholders})
         GROUP BY r_c_no
       )`,
      [...carNos, ...carNos]
    );

    return restorations.map(r => r.r_no);
  } catch (error) {
    console.error('restoration r_no 조회 오류:', error.message);
    return [];
  }
}

export { RESTORATION_STATUS, TASK_STATUS };
