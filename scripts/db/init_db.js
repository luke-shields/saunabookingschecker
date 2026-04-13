export function initDb(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS saunas (
      sauna_name TEXT PRIMARY KEY,
      url TEXT,
      site_key TEXT,
      seats_per_session INTEGER,
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE IF NOT EXISTS scrape_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sauna_name TEXT NOT NULL,
      site_key TEXT,
      scraped_at TEXT NOT NULL,
      source_json_path TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      FOREIGN KEY (sauna_name) REFERENCES saunas(sauna_name)
    );

    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scrape_run_id INTEGER NOT NULL,
      sauna_name TEXT NOT NULL,
      date TEXT,
      time TEXT,
      spots_left INTEGER,
      spots_text TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      FOREIGN KEY (scrape_run_id) REFERENCES scrape_runs(id),
      FOREIGN KEY (sauna_name) REFERENCES saunas(sauna_name)
    );

    CREATE INDEX IF NOT EXISTS idx_observations_run ON observations(scrape_run_id);
    CREATE INDEX IF NOT EXISTS idx_observations_slot ON observations(date, time);

    CREATE TABLE IF NOT EXISTS expected_weekly_open_times (
      sauna_name TEXT NOT NULL,
      weekday INTEGER NOT NULL,
      open_times_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      PRIMARY KEY (sauna_name, weekday),
      FOREIGN KEY (sauna_name) REFERENCES saunas(sauna_name)
    );

    CREATE TABLE IF NOT EXISTS expected_date_open_times_override (
      sauna_name TEXT NOT NULL,
      date TEXT NOT NULL,
      open_times_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      PRIMARY KEY (sauna_name, date),
      FOREIGN KEY (sauna_name) REFERENCES saunas(sauna_name)
    );

    CREATE TABLE IF NOT EXISTS bookings (
      sauna_name TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      scrape_run_id INTEGER,
      scraped_at TEXT,
      is_expected INTEGER NOT NULL,
      is_inferred INTEGER NOT NULL,
      seats_per_session INTEGER,
      spots_left INTEGER,
      seats_booked INTEGER,
      percent_full REAL,
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      PRIMARY KEY (sauna_name, date, time),
      FOREIGN KEY (sauna_name) REFERENCES saunas(sauna_name),
      FOREIGN KEY (scrape_run_id) REFERENCES scrape_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
    CREATE INDEX IF NOT EXISTS idx_bookings_sauna_date ON bookings(sauna_name, date);
  `);

  const obsCols = db
    .prepare("PRAGMA table_info('observations')")
    .all()
    .map((c) => String(c.name));

  const hasPeriodCols =
    obsCols.includes('period_index') ||
    obsCols.includes('period_label') ||
    obsCols.includes('period_suffix');

  if (hasPeriodCols || !obsCols.includes('sauna_name')) {
    db.exec(`DROP VIEW IF EXISTS v_sessions_latest_with_inference;`);

    const saunaNameExpr = obsCols.includes('sauna_name')
      ? "COALESCE(NULLIF(o.sauna_name, ''), (SELECT sauna_name FROM scrape_runs sr WHERE sr.id = o.scrape_run_id), 'Unknown')"
      : "COALESCE((SELECT sauna_name FROM scrape_runs sr WHERE sr.id = o.scrape_run_id), 'Unknown')";

    const createdAtExpr = obsCols.includes('created_at')
      ? 'o.created_at'
      : 'CURRENT_TIMESTAMP';

    db.exec(`
      DROP TABLE IF EXISTS observations__new;
      CREATE TABLE IF NOT EXISTS observations__new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scrape_run_id INTEGER NOT NULL,
        sauna_name TEXT NOT NULL,
        date TEXT,
        time TEXT,
        spots_left INTEGER,
        spots_text TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        FOREIGN KEY (scrape_run_id) REFERENCES scrape_runs(id),
        FOREIGN KEY (sauna_name) REFERENCES saunas(sauna_name)
      );

      INSERT INTO observations__new (id, scrape_run_id, sauna_name, date, time, spots_left, spots_text, created_at)
      SELECT
        o.id,
        o.scrape_run_id,
        ${saunaNameExpr} AS sauna_name,
        o.date,
        o.time,
        o.spots_left,
        o.spots_text,
        ${createdAtExpr} AS created_at
      FROM observations o;

      DROP TABLE observations;
      ALTER TABLE observations__new RENAME TO observations;

      CREATE INDEX IF NOT EXISTS idx_observations_run ON observations(scrape_run_id);
      CREATE INDEX IF NOT EXISTS idx_observations_slot ON observations(date, time);
    `);
  }

  db.exec(`
    DROP VIEW IF EXISTS v_sessions_latest_with_inference;
    CREATE VIEW v_sessions_latest_with_inference AS
    WITH RECURSIVE
      dates(d) AS (
        SELECT date('now', 'localtime')
        UNION ALL
        SELECT date(d, '+1 day') FROM dates WHERE d < date('now', 'localtime', '+9 day')
      ),
      latest_run AS (
        SELECT sauna_name, MAX(id) AS scrape_run_id
        FROM scrape_runs
        GROUP BY sauna_name
      ),
      latest_obs_ranked AS (
        SELECT
          sr.sauna_name AS sauna_name,
          sr.id AS scrape_run_id,
          sr.scraped_at AS scraped_at,
          o.date AS date,
          o.time AS time,
          o.spots_left AS spots_left,
          o.spots_text AS spots_text,
          ROW_NUMBER() OVER (
            PARTITION BY sr.sauna_name, o.date, o.time
            ORDER BY (o.spots_left IS NULL) ASC, o.id DESC
          ) AS rn
        FROM scrape_runs sr
        JOIN latest_run lr ON lr.scrape_run_id = sr.id
        JOIN observations o ON o.scrape_run_id = sr.id
        WHERE o.date IS NOT NULL AND o.time IS NOT NULL
      ),
      latest_obs AS (
        SELECT sauna_name, scrape_run_id, scraped_at, date, time, spots_left, spots_text
        FROM latest_obs_ranked
        WHERE rn = 1
      ),
      expected_dates AS (
        SELECT
          s.sauna_name AS sauna_name,
          s.site_key AS site_key,
          s.seats_per_session AS seats_per_session,
          d.d AS date,
          ((CAST(strftime('%w', d.d) AS INTEGER) + 6) % 7) AS weekday_monday0
        FROM saunas s
        CROSS JOIN dates d
      ),
      expected_source AS (
        SELECT
          ed.sauna_name AS sauna_name,
          ed.site_key AS site_key,
          ed.seats_per_session AS seats_per_session,
          ed.date AS date,
          COALESCE(ov.open_times_json, wk.open_times_json) AS open_times_json
        FROM expected_dates ed
        LEFT JOIN expected_date_open_times_override ov
          ON ov.sauna_name = ed.sauna_name AND ov.date = ed.date
        LEFT JOIN expected_weekly_open_times wk
          ON wk.sauna_name = ed.sauna_name AND wk.weekday = ed.weekday_monday0
      ),
      expected_slots AS (
        SELECT
          es.sauna_name AS sauna_name,
          es.site_key AS site_key,
          es.seats_per_session AS seats_per_session,
          es.date AS date,
          je.value AS time
        FROM expected_source es
        JOIN json_each(es.open_times_json) je
        WHERE (
          es.date > date('now', 'localtime')
          OR (
            es.date = date('now', 'localtime')
            AND je.value >= strftime('%H:%M', 'now', 'localtime')
          )
        )
      ),
      expected_joined AS (
        SELECT
          e.sauna_name AS sauna_name,
          e.site_key AS site_key,
          e.seats_per_session AS seats_per_session,
          e.date AS date,
          e.time AS time,
          lo.scrape_run_id AS scrape_run_id,
          lo.scraped_at AS scraped_at,
          lo.spots_left AS observed_spots_left,
          lo.spots_text AS observed_spots_text
        FROM expected_slots e
        LEFT JOIN latest_obs lo
          ON lo.sauna_name = e.sauna_name AND lo.date = e.date AND lo.time = e.time
      ),
      expected_final AS (
        SELECT
          sauna_name,
          site_key,
          seats_per_session,
          date,
          time,
          scrape_run_id,
          scraped_at,
          1 AS is_expected,
          CASE
            WHEN observed_spots_left IS NULL AND observed_spots_text IS NULL
              AND (
                date != date('now', 'localtime')
                OR EXISTS (
                  SELECT 1
                  FROM latest_obs lo2
                  WHERE lo2.sauna_name = expected_joined.sauna_name
                    AND lo2.date = expected_joined.date
                    AND lo2.time < expected_joined.time
                )
              )
              THEN 1
            ELSE 0
          END AS is_inferred,
          CASE
            WHEN observed_spots_left IS NULL AND observed_spots_text IS NULL
              AND (
                date != date('now', 'localtime')
                OR EXISTS (
                  SELECT 1
                  FROM latest_obs lo2
                  WHERE lo2.sauna_name = expected_joined.sauna_name
                    AND lo2.date = expected_joined.date
                    AND lo2.time < expected_joined.time
                )
              )
              THEN 0
            ELSE observed_spots_left
          END AS spots_left,
          CASE
            WHEN observed_spots_left IS NULL AND observed_spots_text IS NULL
              AND (
                date != date('now', 'localtime')
                OR EXISTS (
                  SELECT 1
                  FROM latest_obs lo2
                  WHERE lo2.sauna_name = expected_joined.sauna_name
                    AND lo2.date = expected_joined.date
                    AND lo2.time < expected_joined.time
                )
              )
              THEN 'Full (inferred)'
            ELSE observed_spots_text
          END AS spots_text
        FROM expected_joined
      ),
      unexpected_obs AS (
        SELECT
          lo.sauna_name AS sauna_name,
          s.site_key AS site_key,
          s.seats_per_session AS seats_per_session,
          lo.date AS date,
          lo.time AS time,
          lo.scrape_run_id AS scrape_run_id,
          lo.scraped_at AS scraped_at,
          0 AS is_expected,
          0 AS is_inferred,
          lo.spots_left AS spots_left,
          lo.spots_text AS spots_text
        FROM latest_obs lo
        JOIN saunas s ON s.sauna_name = lo.sauna_name
        WHERE NOT EXISTS (
          SELECT 1 FROM expected_slots e
          WHERE e.sauna_name = lo.sauna_name AND e.date = lo.date AND e.time = lo.time
        )
      )
    SELECT * FROM expected_final
    UNION ALL
    SELECT * FROM unexpected_obs;
  `);

  db.exec(`
    DROP VIEW IF EXISTS v_metrics_all_time_by_sauna;
    CREATE VIEW v_metrics_all_time_by_sauna AS
    SELECT
      sauna_name,
      COUNT(*) AS sessions,
      AVG(percent_full) AS avg_percent_full,
      SUM(seats_per_session) AS total_seats_available,
      SUM(seats_booked) AS total_seats_booked
    FROM bookings
    GROUP BY sauna_name;

    DROP VIEW IF EXISTS v_metrics_weekly_by_sauna;
    CREATE VIEW v_metrics_weekly_by_sauna AS
    WITH base AS (
      SELECT
        sauna_name,
        date AS date,
        time AS time,
        is_inferred,
        is_expected,
        seats_per_session,
        spots_left,
        seats_booked,
        percent_full,
        scraped_at,
        date(
          date,
          '-' || ((CAST(strftime('%w', date) AS INTEGER) + 6) % 7) || ' days'
        ) AS week_start
      FROM bookings
    )
    SELECT
      sauna_name,
      week_start,
      date(week_start, '+6 days') AS week_end,
      COUNT(*) AS sessions,
      AVG(percent_full) AS avg_percent_full,
      SUM(seats_per_session) AS total_seats_available,
      SUM(seats_booked) AS total_seats_booked
    FROM base
    GROUP BY sauna_name, week_start
    ORDER BY sauna_name, week_start DESC;
  `);
}
