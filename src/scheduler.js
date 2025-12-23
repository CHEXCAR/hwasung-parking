import 'dotenv/config';
import cron from 'node-cron';
import axios from 'axios';
import { fetchMovements, getTodayString } from './crawler.js';
import { insertMovements, getStats } from './database.js';

let isRunning = false;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// Slack 알림 전송
async function sendSlackNotification(message, isError = false) {
  if (!SLACK_WEBHOOK_URL) {
    console.log('Slack 웹훅 URL이 설정되지 않았습니다.');
    return;
  }

  try {
    const emoji = isError ? ':x:' : ':white_check_mark:';
    const color = isError ? '#dc3545' : '#28a745';

    await axios.post(SLACK_WEBHOOK_URL, {
      attachments: [{
        color: color,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${emoji} *화성 주차 관제 시스템*\n${message}`
            }
          },
          {
            type: 'context',
            elements: [{
              type: 'mrkdwn',
              text: `${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`
            }]
          }
        ]
      }]
    });
  } catch (error) {
    console.error('Slack 알림 전송 실패:', error.message);
  }
}

// 크롤링 작업 실행
export async function runCrawlJob() {
  if (isRunning) {
    console.log('이미 크롤링 작업이 실행 중입니다.');
    return;
  }

  isRunning = true;
  const today = getTodayString();

  console.log(`[${new Date().toLocaleString()}] 크롤링 시작: ${today}`);

  try {
    const movements = await fetchMovements(today, today);
    console.log(`수집된 데이터: ${movements.length}건`);

    let inserted = 0;
    if (movements.length > 0) {
      inserted = insertMovements(movements);
      console.log(`새로 저장된 데이터: ${inserted}건`);
    }

    const stats = getStats();
    console.log(`현재 상태 - 전체: ${stats.totalMovements}건, 입차중: ${stats.currentlyParked}대, 오늘: ${stats.todayMovements}건`);

    // 성공 알림 (새 데이터가 있을 때만)
    if (inserted > 0) {
      await sendSlackNotification(
        `크롤링 성공\n` +
        `• 수집: ${movements.length}건\n` +
        `• 신규 저장: ${inserted}건\n` +
        `• 현재 입차중: ${stats.currentlyParked}대`
      );
    }
  } catch (error) {
    console.error('크롤링 실패:', error.message);

    // 실패 알림
    await sendSlackNotification(
      `크롤링 실패\n` +
      `• 에러: ${error.message}`,
      true
    );
  } finally {
    isRunning = false;
  }
}

// 스케줄러 시작 (기본: 5분마다)
export function startScheduler(cronExpression = '*/5 * * * *') {
  console.log(`스케줄러 시작 (${cronExpression})`);
  console.log('Ctrl+C로 종료할 수 있습니다.');

  // 시작 시 즉시 한 번 실행
  runCrawlJob();

  // 스케줄 등록
  cron.schedule(cronExpression, () => {
    runCrawlJob();
  });
}
