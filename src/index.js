#!/usr/bin/env node

import { Command } from 'commander';
import { fetchMovements, getTodayString, getDateRange } from './crawler.js';
import {
  insertMovements,
  getParkedVehicles,
  getParkingCountByLocation,
  getMovementsByDateRange,
  getVehicleHistory,
  getStats,
  closeDb
} from './database.js';
import { startScheduler, runCrawlJob } from './scheduler.js';

const program = new Command();

program
  .name('hwasung-parking')
  .description('화성 주차 관제 시스템')
  .version('1.0.0');

// 오늘 데이터 크롤링
program
  .command('crawl')
  .description('오늘 날짜의 차량 이동 데이터 크롤링')
  .action(async () => {
    try {
      await runCrawlJob();
    } catch (error) {
      console.error('오류:', error.message);
    } finally {
      closeDb();
    }
  });

// 초기 데이터 크롤링 (2025-10-28 ~ 오늘)
program
  .command('init')
  .description('초기 데이터 크롤링 (2025-10-28부터 오늘까지)')
  .action(async () => {
    try {
      const startDate = '2025-10-28';
      const endDate = getTodayString();
      const dates = getDateRange(startDate, endDate);

      console.log(`\n===== 초기 데이터 크롤링 =====`);
      console.log(`기간: ${startDate} ~ ${endDate} (${dates.length}일)`);
      console.log(`===================================\n`);

      let totalInserted = 0;
      let totalFetched = 0;

      for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        const progress = `[${i + 1}/${dates.length}]`;

        process.stdout.write(`${progress} ${date} 크롤링 중...`);

        const movements = await fetchMovements(date, date);
        totalFetched += movements.length;

        if (movements.length > 0) {
          const inserted = insertMovements(movements);
          totalInserted += inserted;
          console.log(` ${movements.length}건 수집, ${inserted}건 저장`);
        } else {
          console.log(` 데이터 없음`);
        }

        // API 부하 방지를 위한 딜레이
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      console.log(`\n===== 초기화 완료 =====`);
      console.log(`총 수집: ${totalFetched}건`);
      console.log(`총 저장: ${totalInserted}건`);

      const stats = getStats();
      console.log(`\n현재 상태:`);
      console.log(`  전체 이동 기록: ${stats.totalMovements}건`);
      console.log(`  현재 입차 중: ${stats.currentlyParked}대`);
    } catch (error) {
      console.error('오류:', error.message);
    } finally {
      closeDb();
    }
  });

// 날짜 범위 크롤링
program
  .command('crawl-range')
  .description('지정한 날짜 범위의 데이터 크롤링')
  .requiredOption('-s, --start <date>', '시작 날짜 (YYYY-MM-DD)')
  .requiredOption('-e, --end <date>', '종료 날짜 (YYYY-MM-DD)')
  .action(async (options) => {
    try {
      const dates = getDateRange(options.start, options.end);
      console.log(`${dates.length}일간의 데이터를 수집합니다...`);

      let totalInserted = 0;
      for (const date of dates) {
        console.log(`\n[${date}] 크롤링 중...`);
        const movements = await fetchMovements(date, date);
        console.log(`수집된 데이터: ${movements.length}건`);

        if (movements.length > 0) {
          const inserted = insertMovements(movements);
          totalInserted += inserted;
          console.log(`새로 저장된 데이터: ${inserted}건`);
        }

        // API 부하 방지를 위한 딜레이
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      console.log(`\n총 ${totalInserted}건의 새로운 데이터가 저장되었습니다.`);
    } catch (error) {
      console.error('오류:', error.message);
    } finally {
      closeDb();
    }
  });

// 현재 입차 차량 조회
program
  .command('parked')
  .description('현재 입차 중인 차량 조회')
  .option('-l, --limit <number>', '표시할 최대 개수', '50')
  .action((options) => {
    try {
      const vehicles = getParkedVehicles();
      const limit = parseInt(options.limit);

      console.log(`\n현재 입차 중인 차량: ${vehicles.length}대\n`);
      console.log('차량번호\t\t입차시각\t\t\t주차시간\t위치');
      console.log('─'.repeat(80));

      vehicles.slice(0, limit).forEach(v => {
        const hours = Math.floor(v.parking_hours);
        const minutes = Math.round((v.parking_hours - hours) * 60);
        const duration = `${hours}시간 ${minutes}분`;
        console.log(`${v.plate_number}\t${v.entry_time}\t${duration}\t${v.location || '-'}`);
      });

      if (vehicles.length > limit) {
        console.log(`\n... 외 ${vehicles.length - limit}대 더 있음`);
      }
    } catch (error) {
      console.error('오류:', error.message);
    } finally {
      closeDb();
    }
  });

// 위치별 주차 현황
program
  .command('locations')
  .description('위치별 주차 수량 조회')
  .action(() => {
    try {
      const locations = getParkingCountByLocation();

      console.log('\n위치별 주차 현황\n');
      console.log('위치\t\t\t주차대수');
      console.log('─'.repeat(40));

      let total = 0;
      locations.forEach(loc => {
        total += loc.count;
        console.log(`${loc.location}\t\t${loc.count}대`);
      });

      console.log('─'.repeat(40));
      console.log(`합계\t\t\t${total}대`);
    } catch (error) {
      console.error('오류:', error.message);
    } finally {
      closeDb();
    }
  });

// 차량 이력 조회
program
  .command('history <plateNumber>')
  .description('특정 차량의 이동 이력 조회')
  .action((plateNumber) => {
    try {
      const history = getVehicleHistory(plateNumber);

      if (history.length === 0) {
        console.log(`\n차량번호 "${plateNumber}"의 이력이 없습니다.`);
        return;
      }

      console.log(`\n차량번호 "${plateNumber}" 이동 이력: ${history.length}건\n`);
      console.log('시각\t\t\t\t유형\t위치');
      console.log('─'.repeat(60));

      history.forEach(h => {
        console.log(`${h.movement_time}\t${h.movement_type}\t${h.location || '-'}`);
      });
    } catch (error) {
      console.error('오류:', error.message);
    } finally {
      closeDb();
    }
  });

// 통계 정보
program
  .command('stats')
  .description('전체 통계 정보 조회')
  .action(() => {
    try {
      const stats = getStats();
      const locations = getParkingCountByLocation();
      const parked = getParkedVehicles();

      console.log('\n===== 화성 주차 관제 시스템 현황 =====\n');
      console.log(`전체 이동 기록: ${stats.totalMovements}건`);
      console.log(`현재 입차 중: ${stats.currentlyParked}대`);
      console.log(`오늘 이동 기록: ${stats.todayMovements}건`);

      if (locations.length > 0) {
        console.log('\n[위치별 현황]');
        locations.forEach(loc => {
          console.log(`  ${loc.location}: ${loc.count}대`);
        });
      }

      // 장시간 주차 차량 (24시간 이상)
      const longParked = parked.filter(v => v.parking_hours >= 24);
      if (longParked.length > 0) {
        console.log(`\n[장기 주차 차량 (24시간 이상): ${longParked.length}대]`);
        longParked.slice(0, 5).forEach(v => {
          const hours = Math.floor(v.parking_hours);
          console.log(`  ${v.plate_number}: ${hours}시간 (${v.location || '위치미상'})`);
        });
        if (longParked.length > 5) {
          console.log(`  ... 외 ${longParked.length - 5}대`);
        }
      }
    } catch (error) {
      console.error('오류:', error.message);
    } finally {
      closeDb();
    }
  });

// 스케줄러 실행
program
  .command('scheduler')
  .description('자동 크롤링 스케줄러 실행')
  .option('-i, --interval <minutes>', '크롤링 주기 (분)', '5')
  .action((options) => {
    const minutes = parseInt(options.interval);
    const cronExpression = `*/${minutes} * * * *`;
    startScheduler(cronExpression);
  });

// 날짜 범위 데이터 조회
program
  .command('search')
  .description('저장된 데이터 조회')
  .option('-s, --start <date>', '시작 날짜 (YYYY-MM-DD)')
  .option('-e, --end <date>', '종료 날짜 (YYYY-MM-DD)')
  .action((options) => {
    try {
      const today = getTodayString();
      const start = options.start ? `${options.start} 00:00:00` : `${today} 00:00:00`;
      const end = options.end ? `${options.end} 23:59:59` : `${today} 23:59:59`;

      const movements = getMovementsByDateRange(start, end);

      console.log(`\n조회 기간: ${start} ~ ${end}`);
      console.log(`조회된 데이터: ${movements.length}건\n`);

      if (movements.length > 0) {
        console.log('시각\t\t\t\t차량번호\t\t유형\t위치');
        console.log('─'.repeat(80));

        movements.slice(0, 50).forEach(m => {
          console.log(`${m.movement_time}\t${m.plate_number}\t${m.movement_type}\t${m.location || '-'}`);
        });

        if (movements.length > 50) {
          console.log(`\n... 외 ${movements.length - 50}건 더 있음`);
        }
      }
    } catch (error) {
      console.error('오류:', error.message);
    } finally {
      closeDb();
    }
  });

// 기본 동작 (인자 없이 실행 시)
if (process.argv.length <= 2) {
  program.outputHelp();
} else {
  program.parse();
}
