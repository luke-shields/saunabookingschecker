class SaunaBookingsApp {
    constructor() {
        this.data = {
            sessions: {},
            saunas: [],
            metrics: [],
            summary: {}
        };
        this.currentTab = 'availability';
        this.init();
    }

    async init() {
        try {
            await this.loadData();
            this.setupEventListeners();
            this.renderSummary();
            this.renderAvailability();
            this.renderMetrics();
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
            const [sessions, saunas, weeklyMetrics, overallMetrics, summary] = await Promise.all([
                fetch('data/sessions.json').then(r => r.json()),
                fetch('data/saunas.json').then(r => r.json()),
                fetch('data/metrics-weekly.json').then(r => r.json()),
                fetch('data/metrics-overall.json').then(r => r.json()),
                fetch('data/summary.json').then(r => r.json())
            ]);

            this.data = { sessions, saunas, weeklyMetrics, overallMetrics, summary };
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
                const sessionsHtml = dateSessions.map(session => this.renderSession(session)).join('');
                return `
                    <div class="sessions-by-date">
                        <div class="date-header">${this.formatDate(date)}</div>
                        <div class="sessions-list">${sessionsHtml}</div>
                    </div>
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
            spotsText = session.spots_text || 'Unknown';
        } else if (session.spots_left === 0) {
            sessionClass += ' full';
            spotsText = 'Full';
        } else {
            sessionClass += ' available';
            spotsText = `${session.spots_left} left`;
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
                                        <span class="stat-value">${metric.total_sessions}</span>
                                        <span class="stat-label">Total Sessions</span>
                                    </div>
                                    <div class="stat-row">
                                        <span class="stat-value">${Math.round(metric.avg_percent_full)}%</span>
                                        <span class="stat-label">Avg % Full</span>
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
