import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '..', 'parking.db');

let db = null;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    initializeDb();
  }
  return db;
}

function initializeDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vehicle_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plate_number TEXT NOT NULL,
      movement_type TEXT NOT NULL,
      movement_time DATETIME NOT NULL,
      location TEXT,
      card_type TEXT,
      raw_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(plate_number, movement_time, movement_type)
    );

    CREATE INDEX IF NOT EXISTS idx_plate_number ON vehicle_movements(plate_number);
    CREATE INDEX IF NOT EXISTS idx_movement_time ON vehicle_movements(movement_time);
    CREATE INDEX IF NOT EXISTS idx_movement_type ON vehicle_movements(movement_type);
    CREATE INDEX IF NOT EXISTS idx_location ON vehicle_movements(location);
  `);
}

// 차량 이동 내역 저장 (중복 무시)
export function insertMovement(movement) {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO vehicle_movements
    (plate_number, movement_type, movement_time, location, card_type, raw_data)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  return stmt.run(
    movement.plateNumber,
    movement.movementType,
    movement.movementTime,
    movement.location || null,
    movement.cardType || null,
    movement.rawData ? JSON.stringify(movement.rawData) : null
  );
}

// 여러 이동 내역 일괄 저장
export function insertMovements(movements) {
  const insert = getDb().prepare(`
    INSERT OR IGNORE INTO vehicle_movements
    (plate_number, movement_type, movement_time, location, card_type, raw_data)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = getDb().transaction((items) => {
    let inserted = 0;
    for (const m of items) {
      const result = insert.run(
        m.plateNumber,
        m.movementType,
        m.movementTime,
        m.location || null,
        m.cardType || null,
        m.rawData ? JSON.stringify(m.rawData) : null
      );
      if (result.changes > 0) inserted++;
    }
    return inserted;
  });

  return insertMany(movements);
}

// 현재 입차 중인 차량 조회 (차량번호별 최신 입차, 그 후 출차 없는 경우)
export function getParkedVehicles() {
  const stmt = getDb().prepare(`
    SELECT
      v.plate_number,
      v.movement_time as entry_time,
      v.location,
      v.card_type,
      ROUND((JULIANDAY('now', 'localtime') - JULIANDAY(v.movement_time)) * 24, 2) as parking_hours
    FROM vehicle_movements v
    INNER JOIN (
      SELECT plate_number, MAX(movement_time) as max_time
      FROM vehicle_movements
      WHERE movement_type = '입차'
      GROUP BY plate_number
    ) latest ON v.plate_number = latest.plate_number AND v.movement_time = latest.max_time
    WHERE v.movement_type = '입차'
    AND NOT EXISTS (
      SELECT 1 FROM vehicle_movements v2
      WHERE v2.plate_number = v.plate_number
      AND v2.movement_type = '출차'
      AND v2.movement_time > v.movement_time
    )
    ORDER BY v.movement_time DESC
  `);

  return stmt.all();
}

// 위치별 주차 수량 조회 (차량번호 유니크)
export function getParkingCountByLocation() {
  const stmt = getDb().prepare(`
    SELECT
      COALESCE(v.location, '미지정') as location,
      COUNT(*) as count
    FROM vehicle_movements v
    INNER JOIN (
      SELECT plate_number, MAX(movement_time) as max_time
      FROM vehicle_movements
      WHERE movement_type = '입차'
      GROUP BY plate_number
    ) latest ON v.plate_number = latest.plate_number AND v.movement_time = latest.max_time
    WHERE v.movement_type = '입차'
    AND NOT EXISTS (
      SELECT 1 FROM vehicle_movements v2
      WHERE v2.plate_number = v.plate_number
      AND v2.movement_type = '출차'
      AND v2.movement_time > v.movement_time
    )
    GROUP BY v.location
    ORDER BY count DESC
  `);

  return stmt.all();
}

// 날짜 범위로 이동 내역 조회
export function getMovementsByDateRange(startDate, endDate) {
  const stmt = getDb().prepare(`
    SELECT * FROM vehicle_movements
    WHERE movement_time BETWEEN ? AND ?
    ORDER BY movement_time DESC
  `);

  return stmt.all(startDate, endDate);
}

// 특정 차량의 이동 내역 조회
export function getVehicleHistory(plateNumber) {
  const stmt = getDb().prepare(`
    SELECT * FROM vehicle_movements
    WHERE plate_number = ?
    ORDER BY movement_time DESC
  `);

  return stmt.all(plateNumber);
}

// 통계 정보
export function getStats() {
  const totalMovements = getDb().prepare('SELECT COUNT(*) as count FROM vehicle_movements').get();

  // 차량번호별 유니크하게 입차 중인 차량 수
  const parkedCount = getDb().prepare(`
    SELECT COUNT(*) as count FROM (
      SELECT v.plate_number
      FROM vehicle_movements v
      INNER JOIN (
        SELECT plate_number, MAX(movement_time) as max_time
        FROM vehicle_movements
        WHERE movement_type = '입차'
        GROUP BY plate_number
      ) latest ON v.plate_number = latest.plate_number AND v.movement_time = latest.max_time
      WHERE v.movement_type = '입차'
      AND NOT EXISTS (
        SELECT 1 FROM vehicle_movements v2
        WHERE v2.plate_number = v.plate_number
        AND v2.movement_type = '출차'
        AND v2.movement_time > v.movement_time
      )
    )
  `).get();

  const todayMovements = getDb().prepare(`
    SELECT COUNT(*) as count FROM vehicle_movements
    WHERE DATE(movement_time) = DATE('now', 'localtime')
  `).get();

  return {
    totalMovements: totalMovements.count,
    currentlyParked: parkedCount.count,
    todayMovements: todayMovements.count
  };
}

// 마지막 업데이트 시간 조회
export function getLastUpdateTime() {
  const result = getDb().prepare(`
    SELECT MAX(created_at) as last_update FROM vehicle_movements
  `).get();
  return result?.last_update || null;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
