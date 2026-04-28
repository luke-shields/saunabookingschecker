class SaunaBookingsApp {
    constructor() {
        this.data = {
            sessions: {},
            saunas: [],
            metrics: [],
            summary: {}
        };
        this.currentTab = 'availability';
        this.historySelection = new Set();
        this.init();
    }

    async init() {
        try {
            await this.loadData();
            this.setupEventListeners();
            this.renderSummary();
            this.renderAvailability();
            this.renderMetrics();
            this.renderHistory();
            this.renderSaunas();
        } catch (error) {
            console.error('Failed to initialize app:', error);
            this.showError('Failed to load sauna data');
        }
    }

    async loadData() {
        const loadingElements = document.querySelectorAll('.loading');
        loadingElements.forEach(el => el.classList.add('loading'));

        try {
            const [sessions, saunas, weeklyMetrics, overallMetrics, history, summary] = await Promise.all([
                fetch('data/sessions.json').then(r => r.json()),
                fetch('data/saunas.json').then(r => r.json()),
                fetch('data/metrics-weekly.json').then(r => r.json()),
                fetch('data/metrics-overall.json').then(r => r.json()),
                fetch('data/history.json').then(r => r.json()).catch(() => ({})),
                fetch('data/summary.json').then(r => r.json())
            ]);

            this.data = { sessions, saunas, weeklyMetrics, overallMetrics, history, summary };
            console.log('Data loaded successfully:', this.data);
        } catch (error) {
            console.error('Error loading data:', error);
            throw error;
        } finally {
            loadingElements.forEach(el => el.classList.remove('loading'));
        }
    }

    setupEventListeners() {
        // Tab switching
        document.querySelectorAll('.tab-button').forEach(button => {
            button.addEventListener('click', (e) => {
                const tab = e.target.getAttribute('data-tab');
                this.switchTab(tab);
            });
        });
    }

    switchTab(tabName) {
        // Update buttons
        document.querySelectorAll('.tab-button').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
        });

        // Update content
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.toggle('active', content.id === tabName);
        });

        this.currentTab = tabName;
    }

    renderSummary() {
        const container = document.getElementById('summaryCards');
        const { summary } = this.data;

        container.innerHTML = `
            <div class="summary-card">
                <span class="summary-value">${summary.totalSaunas || 0}</span>
                <span class="summary-label">Saunas</span>
            </div>
            <div class="summary-card">
                <span class="summary-value">${summary.totalUpcomingSessions || 0}</span>
                <span class="summary-label">Upcoming Sessions</span>
            </div>
            <div class="summary-card">
                <span class="summary-value">${summary.availableSpotsTotal || 0}</span>
                <span class="summary-label">Available Spots</span>
            </div>
        `;

        // Update last updated time
        const lastUpdatedEl = document.getElementById('lastUpdated');
        if (summary.lastUpdated) {
            const date = new Date(summary.lastUpdated);
            lastUpdatedEl.textContent = `Last updated: ${this.formatDateTime(date)}`;
        }
    }

    renderAvailability() {
        const container = document.getElementById('saunaGrid');
        const { sessions, saunas } = this.data;

        if (!sessions || Object.keys(sessions).length === 0) {
            container.innerHTML = '<div class="no-sessions">No session data available</div>';
            return;
        }

        const saunaCards = Object.entries(sessions).map(([saunaName, saunaSessions]) => {
            const saunaInfo = saunas.find(s => s.sauna_name === saunaName);
            const capacity = saunaInfo?.seats_per_session || 'Unknown';

            // Group sessions by date
            const sessionsByDate = this.groupSessionsByDate(saunaSessions);

            const dateGroups = Object.entries(sessionsByDate).map(([date, dateSessions]) => {
                const totals = this.summariseDay(dateSessions);
                const sessionsHtml = dateSessions.map(session => this.renderSession(session)).join('');
                const summaryText = totals.totalSeats > 0
                    ? `${totals.totalBooked} / ${totals.totalSeats} booked`
                    : `${dateSessions.length} session${dateSessions.length === 1 ? '' : 's'}`;
                return `
                    <details class="sessions-by-date">
                        <summary class="date-header">
                            <span class="date-header-label">${this.formatDate(date)}</span>
                            <span class="date-header-summary">${summaryText}</span>
                        </summary>
                        <div class="sessions-list">${sessionsHtml}</div>
                    </details>
                `;
            }).join('');

            return `
                <div class="sauna-card">
                    <div class="sauna-header">
                        <div class="sauna-name">${saunaName}</div>
                        <div class="sauna-capacity">${capacity} spots per session</div>
                    </div>
                    <div class="sessions-container">
                        ${dateGroups || '<div class="no-sessions">No upcoming sessions</div>'}
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = saunaCards;
    }

    renderSession(session) {
        let sessionClass = 'session';
        let spotsText = '';

        if (session.is_inferred) {
            sessionClass += ' inferred';
        }

        if (session.spots_left === null) {
            sessionClass += ' unknown';
            spotsText = 'Unknown';
        } else if (session.spots_left === 0) {
            sessionClass += ' full';
            spotsText = 'Full';
        } else {
            sessionClass += ' available';
            const displaySpots = session.seats_per_session != null
                ? Math.min(session.spots_left, session.seats_per_session)
                : session.spots_left;
            spotsText = `${displaySpots} left`;
        }

        const time = session.session_time.substring(0, 5); // HH:MM format

        return `
            <div class="${sessionClass}">
                <div class="session-time">${time}</div>
                <div class="session-spots">${spotsText}</div>
            </div>
        `;
    }

    renderMetrics() {
        const container = document.getElementById('metricsContainer');
        const { weeklyMetrics, overallMetrics } = this.data;

        if (!weeklyMetrics && !overallMetrics) {
            container.innerHTML = '<div class="no-sessions">No metrics data available</div>';
            return;
        }

        let html = '';

        // Overall metrics section
        if (overallMetrics && overallMetrics.length > 0) {
            html += `
                <div class="metrics-section">
                    <h2 class="section-title">📊 Overall Performance</h2>
                    <div class="overall-metrics-grid">
                        ${overallMetrics.map(metric => `
                            <div class="overall-metric-card">
                                <h3 class="metric-sauna-name">${metric.sauna_name}</h3>
                                <div class="metric-stats">
                                    <div class="stat-row">
                                        <span class="stat-value">${metric.avg_sessions_per_week != null ? metric.avg_sessions_per_week.toFixed(1) : '—'}</span>
                                        <span class="stat-label">Avg Sessions / Week</span>
                                    </div>
                                    <div class="stat-row">
                                        <span class="stat-value">${Math.round(metric.avg_percent_full)}%</span>
                                        <span class="stat-label">Avg % Full</span>
                                    </div>
                                    <div class="stat-row">
                                        <span class="stat-value">${metric.total_seats_available}</span>
                                        <span class="stat-label">Seats Available</span>
                                    </div>
                                    <div class="stat-row">
                                        <span class="stat-value">${metric.total_seats_booked}</span>
                                        <span class="stat-label">Seats Booked</span>
                                    </div>
                                    <div class="stat-row">
                                        <span class="stat-value">${metric.weeks_tracked}</span>
                                        <span class="stat-label">Weeks Tracked</span>
                                    </div>
                                    <div class="stat-period">
                                        ${this.formatWeekDate(metric.earliest_week)} - ${this.formatWeekDate(metric.latest_week)}
                                    </div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }

        // Weekly metrics section
        if (weeklyMetrics && weeklyMetrics.length > 0) {
            // Group weekly metrics by sauna
            const weeklyBySauna = {};
            weeklyMetrics.forEach(metric => {
                if (!weeklyBySauna[metric.sauna_name]) {
                    weeklyBySauna[metric.sauna_name] = [];
                }
                weeklyBySauna[metric.sauna_name].push(metric);
            });

            html += `
                <div class="metrics-section">
                    <h2 class="section-title">📅 Weekly Trends</h2>
                    ${Object.entries(weeklyBySauna).map(([saunaName, weeks]) => `
                        <div class="weekly-sauna-metrics">
                            <h3 class="weekly-sauna-title">${saunaName}</h3>
                            <div class="weekly-metrics-scroll">
                                ${weeks.slice(0, 8).map(week => `
                                    <div class="weekly-metric-card">
                                        <div class="week-period">
                                            ${this.formatWeekDate(week.week_start)} - ${this.formatWeekDate(week.week_end)}
                                        </div>
                                        <div class="week-stats">
                                            <div class="week-stat">
                                                <span class="week-value">${week.sessions}</span>
                                                <span class="week-label">Sessions</span>
                                            </div>
                                            <div class="week-stat">
                                                <span class="week-value">${Math.round(week.avg_percent_full)}%</span>
                                                <span class="week-label">% Full</span>
                                            </div>
                                            <div class="week-stat">
                                                <span class="week-value">${week.total_seats_booked}</span>
                                                <span class="week-label">Booked</span>
                                            </div>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        container.innerHTML = html;
    }

    renderHistory() {
        const container = document.getElementById('historyContainer');
        if (!container) return;

        const history = this.data.history || {};
        const saunaNames = Object.keys(history).filter(n => (history[n] || []).length > 0).sort();

        if (saunaNames.length === 0) {
            container.innerHTML = '<div class="no-sessions">No historical data available yet.</div>';
            return;
        }

        // Default selection: all saunas on first render
        if (this.historySelection.size === 0) {
            saunaNames.forEach(n => this.historySelection.add(n));
        }

        // Build chip selector + body shell
        container.innerHTML = `
            <div class="history-controls">
                <div class="history-chip-row" id="historyChipRow"></div>
                <div class="history-legend">
                    <span class="legend-label">Less booked</span>
                    <span class="legend-gradient"></span>
                    <span class="legend-label">More booked</span>
                    <span class="legend-divider"></span>
                    <span class="legend-swatch unknown"></span>
                    <span class="legend-label">Unknown</span>
                </div>
            </div>
            <div class="history-body" id="historyBody"></div>
        `;

        // Render chips
        const chipRow = container.querySelector('#historyChipRow');
        chipRow.innerHTML = saunaNames.map(name => `
            <button type="button" class="history-chip ${this.historySelection.has(name) ? 'active' : ''}" data-sauna="${this.escapeAttr(name)}">
                ${name}
            </button>
        `).join('') + `
            <span class="history-chip-spacer"></span>
            <button type="button" class="history-chip-action" data-action="all">All</button>
            <button type="button" class="history-chip-action" data-action="none">None</button>
        `;

        chipRow.querySelectorAll('.history-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                const name = btn.getAttribute('data-sauna');
                if (this.historySelection.has(name)) this.historySelection.delete(name);
                else this.historySelection.add(name);
                this.renderHistory();
            });
        });
        chipRow.querySelectorAll('.history-chip-action').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.getAttribute('data-action');
                this.historySelection.clear();
                if (action === 'all') saunaNames.forEach(n => this.historySelection.add(n));
                this.renderHistory();
            });
        });

        // Render body
        const body = container.querySelector('#historyBody');
        const selected = saunaNames.filter(n => this.historySelection.has(n));
        if (selected.length === 0) {
            body.innerHTML = '<div class="no-sessions">Select one or more saunas above to view history.</div>';
            return;
        }

        // Compute global date range across selected saunas for aligned x-axis
        const allDates = new Set();
        selected.forEach(name => {
            (history[name] || []).forEach(r => allDates.add(r.date));
        });
        const dateList = Array.from(allDates).sort();
        if (dateList.length === 0) {
            body.innerHTML = '<div class="no-sessions">No sessions on record for selected saunas.</div>';
            return;
        }

        body.innerHTML = selected
            .map(name => this.renderHistoryStrip(name, history[name] || [], dateList))
            .join('');

        // Attach hover tooltip
        this.attachHistoryTooltip(body);
    }

    renderHistoryStrip(saunaName, rows, dateList) {
        // Index rows by date -> Map<time, row>
        const byDate = new Map();
        const timeSet = new Set();
        for (const r of rows) {
            if (!r.time) continue;
            if (!byDate.has(r.date)) byDate.set(r.date, new Map());
            byDate.get(r.date).set(r.time, r);
            timeSet.add(r.time);
        }
        const times = Array.from(timeSet).sort();
        if (times.length === 0) {
            return `
                <div class="history-strip">
                    <div class="history-strip-header"><h3>${saunaName}</h3></div>
                    <div class="no-sessions">No timed sessions recorded.</div>
                </div>
            `;
        }

        const dateLabels = this.buildDateAxisLabels(dateList);
        const dateLabelMap = new Map(dateLabels.map(l => [l.index, l.label]));

        // Build header row
        const headerCells = dateList.map((_, ci) => {
            const label = dateLabelMap.get(ci);
            return `<th class="haxis-date">${label || ''}</th>`;
        }).join('');

        // Build body rows (one per time slot)
        const bodyRows = times.map(time => {
            const cells = dateList.map(date => {
                const row = byDate.get(date)?.get(time);
                if (!row) return `<td class="hcell empty">&nbsp;</td>`;
                const cap = row.seats_per_session;
                const left = row.spots_left;
                const pct = row.percent_full;
                const booked = row.seats_booked;
                let cls = 'hcell';
                let style = '';
                if (pct == null || left == null) {
                    cls += ' unknown';
                } else {
                    style = `background:${this.percentToColor(pct)};`;
                }
                const tip = `${saunaName} \u2022 ${this.formatDate(date)} ${time} \u2022 ${booked ?? '?'} / ${cap ?? '?'} booked${pct != null ? ` (${Math.round(pct)}%)` : ''}`;
                return `<td class="${cls}" style="${style}" data-tip="${this.escapeAttr(tip)}">&nbsp;</td>`;
            }).join('');
            return `<tr><th class="haxis-time">${time}</th>${cells}</tr>`;
        }).join('');

        // Compute summary stats
        const known = rows.filter(r => r.percent_full != null);
        const avgPct = known.length ? (known.reduce((s, r) => s + r.percent_full, 0) / known.length) : null;
        const totalSessions = rows.length;
        const dateSpan = `${this.formatDate(dateList[0])} \u2013 ${this.formatDate(dateList[dateList.length - 1])}`;

        return `
            <div class="history-strip">
                <div class="history-strip-header">
                    <h3>${saunaName}</h3>
                    <div class="history-strip-meta">
                        <span>${totalSessions} sessions</span>
                        <span>\u2022</span>
                        <span>${dateSpan}</span>
                        ${avgPct != null ? `<span>\u2022</span><span>avg ${Math.round(avgPct)}% full</span>` : ''}
                    </div>
                </div>
                <div class="history-grid-scroll">
                    <table class="history-table">
                        <thead><tr><th></th>${headerCells}</tr></thead>
                        <tbody>${bodyRows}</tbody>
                    </table>
                </div>
            </div>
        `;
    }

    buildDateAxisLabels(dateList) {
        const labels = [];
        const total = dateList.length;
        // For small datasets show every date, for larger ones show every few days
        const step = total <= 14 ? 1 : total <= 60 ? 3 : 7;
        let lastMonth = null;
        for (let i = 0; i < total; i++) {
            if (i % step !== 0 && i !== total - 1) continue;
            const d = new Date(dateList[i] + 'T00:00:00');
            const day = d.getDate();
            const m = d.getMonth();
            const showMonth = m !== lastMonth;
            lastMonth = m;
            const label = showMonth
                ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
                : String(day);
            labels.push({ index: i, label });
        }
        return labels;
    }

    percentToColor(pct) {
        // 0% = light teal, 100% = deep red, smooth HSL interpolation.
        const p = Math.max(0, Math.min(100, pct)) / 100;
        // Hue from 170 (teal) -> 0 (red); saturation 65%; lightness 90% -> 50%.
        const hue = 170 - 170 * p;
        const sat = 65;
        const light = 90 - 40 * p;
        return `hsl(${hue.toFixed(0)}, ${sat}%, ${light.toFixed(0)}%)`;
    }

    attachHistoryTooltip(root) {
        let tip = document.getElementById('historyTooltip');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'historyTooltip';
            tip.className = 'history-tooltip';
            document.body.appendChild(tip);
        }
        const show = (e) => {
            const target = e.target.closest('.hcell[data-tip]');
            if (!target) { tip.style.opacity = '0'; return; }
            tip.textContent = target.getAttribute('data-tip');
            tip.style.opacity = '1';
            const r = target.getBoundingClientRect();
            tip.style.left = `${r.left + r.width / 2 + window.scrollX}px`;
            tip.style.top = `${r.top + window.scrollY - 8}px`;
        };
        const hide = () => { tip.style.opacity = '0'; };
        root.addEventListener('mousemove', show);
        root.addEventListener('mouseleave', hide);
    }

    escapeAttr(s) {
        return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    renderSaunas() {
        const container = document.getElementById('saunasList');
        const { saunas } = this.data;

        if (!saunas || saunas.length === 0) {
            container.innerHTML = '<div class="no-sessions">No sauna information available</div>';
            return;
        }

        const saunaItems = saunas.map(sauna => `
            <div class="sauna-info">
                <div class="sauna-info-content">
                    <h3>${sauna.sauna_name}</h3>
                    <a href="${sauna.url}" target="_blank" class="sauna-url" rel="noopener noreferrer">
                        ${sauna.url}
                    </a>
                </div>
                <div class="sauna-capacity-badge">
                    ${sauna.seats_per_session} spots
                </div>
            </div>
        `).join('');

        container.innerHTML = saunaItems;
    }

    summariseDay(sessions) {
        let totalSeats = 0;
        let totalBooked = 0;
        for (const s of sessions) {
            const cap = s.seats_per_session;
            if (cap == null) continue;
            if (s.spots_left == null) continue;
            const left = Math.max(0, Math.min(s.spots_left, cap));
            totalSeats += cap;
            totalBooked += (cap - left);
        }
        return { totalSeats, totalBooked };
    }

    groupSessionsByDate(sessions) {
        return sessions.reduce((acc, session) => {
            const date = session.session_date;
            if (!acc[date]) {
                acc[date] = [];
            }
            acc[date].push(session);
            return acc;
        }, {});
    }

    formatDate(dateStr) {
        const date = new Date(dateStr + 'T00:00:00');
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        if (date.toDateString() === today.toDateString()) {
            return 'Today';
        } else if (date.toDateString() === tomorrow.toDateString()) {
            return 'Tomorrow';
        } else {
            return date.toLocaleDateString('en-GB', { 
                weekday: 'short', 
                day: 'numeric', 
                month: 'short' 
            });
        }
    }

    formatWeekDate(dateStr) {
        const date = new Date(dateStr + 'T00:00:00');
        return date.toLocaleDateString('en-GB', { 
            weekday: 'short', 
            day: 'numeric', 
            month: 'short' 
        });
    }

    formatDateTime(date) {
        return date.toLocaleString('en-GB', {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    showError(message) {
        const container = document.querySelector('.main');
        container.innerHTML = `
            <div class="error" style="
                text-align: center;
                padding: 3rem;
                color: #ef4444;
                background: #fef2f2;
                border: 1px solid #fecaca;
                border-radius: 12px;
            ">
                <h2>⚠️ Error</h2>
                <p>${message}</p>
                <button onclick="location.reload()" style="
                    margin-top: 1rem;
                    padding: 0.5rem 1rem;
                    background: #ef4444;
                    color: white;
                    border: none;
                    border-radius: 8px;
                    cursor: pointer;
                ">Reload Page</button>
            </div>
        `;
    }
}

// Initialize the app when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new SaunaBookingsApp();
});
