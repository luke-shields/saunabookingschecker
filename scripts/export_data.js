#!/usr/bin/env node

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = 'sauna_bookings.sqlite';
const OUTPUT_DIR = 'docs';

function exportData() {
  const db = new Database(DB_PATH);
  
  try {
    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Export current sessions with availability
    const currentSessions = db.prepare(`
      SELECT 
        sauna_name,
        date as session_date,
        time as session_time,
        spots_left,
        spots_text,
        scraped_at as last_updated,
        seats_per_session,
        is_expected,
        is_inferred
      FROM v_sessions_latest_with_inference 
      WHERE date >= date('now')
      ORDER BY sauna_name, date, time
    `).all();

    // Export sauna information
    const saunas = db.prepare(`
      SELECT 
        sauna_name,
        url,
        seats_per_session
      FROM saunas
      ORDER BY sauna_name
    `).all();

    // Export weekly metrics - get last 8 weeks of data
    const weeklyMetrics = db.prepare(`
      SELECT 
        sauna_name,
        week_start,
        week_end,
        sessions,
        avg_percent_full,
        total_seats_available,
        total_seats_booked
      FROM v_metrics_weekly_by_sauna
      ORDER BY sauna_name, week_start DESC
      LIMIT 200
    `).all();

    // Export full historical bookings per sauna (every recorded session)
    const history = db.prepare(`
      SELECT
        sauna_name,
        date,
        time,
        seats_per_session,
        spots_left,
        seats_booked,
        percent_full
      FROM bookings
      WHERE seats_per_session IS NOT NULL
      ORDER BY sauna_name, date, time
    `).all();

    // Group history by sauna for compact frontend consumption
    const historyBySauna = history.reduce((acc, row) => {
      if (!acc[row.sauna_name]) acc[row.sauna_name] = [];
      acc[row.sauna_name].push({
        date: row.date,
        time: row.time ? row.time.substring(0, 5) : null,
        seats_per_session: row.seats_per_session,
        spots_left: row.spots_left,
        seats_booked: row.seats_booked,
        percent_full: row.percent_full,
      });
      return acc;
    }, {});

    // Export overall metrics per sauna
    const overallMetrics = db.prepare(`
      SELECT 
        sauna_name,
        AVG(sessions) as avg_sessions_per_week,
        AVG(avg_percent_full) as avg_percent_full,
        SUM(total_seats_available) as total_seats_available,
        SUM(total_seats_booked) as total_seats_booked,
        MIN(week_start) as earliest_week,
        MAX(week_end) as latest_week,
        COUNT(DISTINCT week_start) as weeks_tracked
      FROM v_metrics_weekly_by_sauna
      GROUP BY sauna_name
      ORDER BY sauna_name
    `).all();

    // Export summary stats
    const summary = {
      totalSaunas: saunas.length,
      totalUpcomingSessions: currentSessions.length,
      lastUpdated: new Date().toISOString(),
      availableSpotsTotal: currentSessions
        .filter(s => s.spots_left !== null)
        .reduce((sum, s) => sum + s.spots_left, 0)
    };

    // Group sessions by sauna for easier frontend consumption
    const sessionsBySauna = currentSessions.reduce((acc, session) => {
      if (!acc[session.sauna_name]) {
        acc[session.sauna_name] = [];
      }
      acc[session.sauna_name].push(session);
      return acc;
    }, {});

    // Write JSON files
    const dataExports = {
      'data/sessions.json': sessionsBySauna,
      'data/saunas.json': saunas,
      'data/metrics-weekly.json': weeklyMetrics,
      'data/metrics-overall.json': overallMetrics,
      'data/history.json': historyBySauna,
      'data/summary.json': summary
    };

    // Ensure data subdirectory exists
    const dataDir = path.join(OUTPUT_DIR, 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    for (const [filename, data] of Object.entries(dataExports)) {
      const filepath = path.join(OUTPUT_DIR, filename);
      fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
      console.log(`✓ Exported ${filename}`);
    }

    console.log(`\n📊 Data export complete:
    - ${saunas.length} saunas
    - ${currentSessions.length} upcoming sessions
    - ${summary.availableSpotsTotal} total available spots
    - Last updated: ${summary.lastUpdated}`);

  } catch (error) {
    console.error('Error exporting data:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  exportData();
}

export { exportData };
