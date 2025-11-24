const userApp = {
    mixins: [dashboardMixin],
    data() {
        return {
            user: { username: '', email: '', id: null, avatar: '' },
            currentSection: 'home',
            parkingLots: [],
            lotsLoaded: false,
            lotSearch: '',
            reservations: [],
            reservationsLoaded: false,
            profileForm: {
                username: '',
                email: '',
                avatar: '',
                currentPassword: '',
                newPassword: '',
                confirmPassword: ''
            },
            bookingForm: {
                vehicleNumber: '',
                lotId: null,
                lotName: '',
                address: '',
                price: 0
            },
            bookingError: '',
            booking: false,
            releasing: false,
            message: '',
            messageType: '',
            showBookingModal: false,
            statsLoaded: false,
            chartsLoading: false,
            stats: {
                totalBookings: 0,
                totalSpent: 0,
                lotUsage: [],
                monthlySpend: []
            },
            now: Date.now(),
            exporting: false,
            timer: null
        }
    },
    async mounted() {
        try {
            const response = await axios.get('/api/current-user');
            this.user = response.data;
        } catch (error) {
            window.location.href = '/';
            return;
        }
        if (this.user.role !== 'user') {
            window.location.href = '/admin_dashboard';
            return;
        }
        this.loadLots();
        this.loadReservations();
        this.loadStats();
    },
    beforeUnmount() {
        clearInterval(this.timer);
    },
    computed: {
        activeBooking() {
            return this.reservations.find(res => res.status === 'active') || null;
        },
        hasActiveBooking() {
            return this.activeBooking !== null;
        },
        // The active booking has no cost yet, so it is left out of the average.
        averageCost() {
            const completed = this.stats.totalBookings - (this.hasActiveBooking ? 1 : 0);
            return completed > 0 ? this.stats.totalSpent / completed : 0;
        },
        filteredLots() {
            const query = this.lotSearch.trim().toLowerCase();
            const lots = query
                ? this.parkingLots.filter(lot =>
                    [lot.prime_location_name, lot.address, lot.pin_code].some(value => String(value || '').toLowerCase().includes(query)))
                : this.parkingLots.slice();
            // Lots with free spots first; full lots stay visible but last.
            return lots.sort((a, b) => (b.available_spots > 0) - (a.available_spots > 0));
        }
    },
    watch: {
        // The session timer ticks every second only while a booking is active.
        hasActiveBooking(active) {
            clearInterval(this.timer);
            this.timer = null;
            if (active) {
                this.now = Date.now();
                this.timer = setInterval(() => { this.now = Date.now(); }, 1000);
            }
        }
    },
    methods: {
        switchSection(section) {
            this.closeNav();
            this.destroyCharts();
            this.currentSection = section;
            this.message = '';

            if (section === 'home') {
                this.loadLots();
                this.loadReservations();
                this.loadStats();
            } else if (section === 'history') {
                this.loadReservations();
            } else if (section === 'charts') {
                this.loadCharts();
            } else if (section === 'profile') {
                this.profileForm.username = this.user.username;
                this.profileForm.email = this.user.email;
                this.profileForm.avatar = this.user.avatar || 'avatar1.png';
            }
        },
        closeModals() {
            this.showBookingModal = false;
        },
        async loadLots() {
            try {
                const response = await axios.get('/api/parking-lots');
                this.parkingLots = response.data;
            } catch (error) {
                this.showMessage(errorMessage(error, 'Failed to load parking locations'), 'error');
            } finally {
                this.lotsLoaded = true;
            }
        },
        async loadReservations() {
            try {
                const response = await axios.get(`/api/user-reservations/${this.user.id}`);
                this.reservations = response.data;
            } catch (error) {
                this.showMessage(errorMessage(error, 'Failed to load your bookings'), 'error');
            } finally {
                this.reservationsLoaded = true;
            }
        },
        async loadStats() {
            try {
                const response = await axios.get(`/api/user-stats/${this.user.id}`);
                this.stats.totalBookings = response.data.total_bookings || 0;
                this.stats.totalSpent = response.data.total_spent || 0;
                this.stats.lotUsage = response.data.lot_usage || [];
                this.stats.monthlySpend = response.data.monthly_spend || [];
                this.statsLoaded = true;
            } catch (error) {
                this.showMessage(errorMessage(error, 'Failed to load your statistics'), 'error');
            }
        },
        async loadCharts() {
            this.chartsLoading = true;
            await this.loadStats();
            this.chartsLoading = false;
            this.$nextTick(this.renderCharts);
        },
        renderCharts() {
            const usage = this.stats.lotUsage;
            this.renderChart('spending', 'userChart', {
                type: 'bar',
                data: {
                    labels: usage.map(lot => lot.location_name),
                    datasets: [{
                        label: 'Spent (₹)',
                        data: usage.map(lot => lot.total_spent),
                        backgroundColor: CHART_YELLOW,
                        borderColor: CHART_DARK,
                        borderWidth: 2,
                        borderRadius: 8
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { beginAtZero: true, grid: { color: CHART_GRID } },
                        x: { grid: { display: false } }
                    }
                }
            });

            const monthly = this.stats.monthlySpend;
            this.renderChart('monthly', 'monthlyChart', {
                type: 'bar',
                data: {
                    labels: monthly.map(month => month.label),
                    datasets: [{
                        label: 'Spent (₹)',
                        data: monthly.map(month => month.total_spent),
                        backgroundColor: CHART_YELLOW,
                        borderColor: CHART_DARK,
                        borderWidth: 2,
                        borderRadius: 8
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                afterLabel: item => {
                                    const count = monthly[item.dataIndex].bookings;
                                    return `${count} ${count === 1 ? 'booking' : 'bookings'}`;
                                }
                            }
                        }
                    },
                    scales: {
                        y: { beginAtZero: true, grid: { color: CHART_GRID } },
                        x: { grid: { display: false } }
                    }
                }
            });
        },
        openBookingModal(lot) {
            this.bookingForm = {
                vehicleNumber: '',
                lotId: lot.id,
                lotName: lot.prime_location_name,
                address: lot.address,
                price: lot.price
            };
            this.bookingError = '';
            this.showBookingModal = true;
            this.focusField('vehicleNumber');
        },
        async bookSpot() {
            this.bookingError = '';
            this.booking = true;
            try {
                const response = await axios.post('/api/book-spot', {
                    lot_id: this.bookingForm.lotId,
                    vehicle_number: this.bookingForm.vehicleNumber
                });
                this.showBookingModal = false;
                this.showMessage(response.data.message, 'success');
                this.loadLots();
                this.loadReservations();
                this.loadStats();
            } catch (error) {
                this.bookingError = errorMessage(error, 'Failed to book spot');
                // A full lot or a booking made in another tab: refresh what is shown.
                if (error.response?.status === 409) {
                    this.loadLots();
                    this.loadReservations();
                }
            } finally {
                this.booking = false;
            }
        },
        async releaseSpot(reservationId) {
            if (!await this.askConfirm('End session', 'End this parking session? You will be charged for the time parked.', 'End session')) return;
            this.releasing = true;
            try {
                const response = await axios.put(`/api/release-spot/${reservationId}`);
                this.showMessage(`Session ended. Total cost: ${this.formatRupees(response.data.parking_cost)}`, 'success');
                this.loadLots();
                this.loadReservations();
                this.loadStats();
            } catch (error) {
                this.showMessage(errorMessage(error, 'Failed to end session'), 'error');
                // Already ended in another tab: refresh what is shown.
                if (error.response?.status === 409) {
                    this.loadLots();
                    this.loadReservations();
                    this.loadStats();
                }
            } finally {
                this.releasing = false;
            }
        },
        async exportCsv() {
            this.exporting = true;
            try {
                const start = await axios.post('/api/export-csv');
                this.showMessage('Export queued, preparing your file.', 'info');
                const taskId = start.data.task_id;
                for (let i = 0; i < 40; i++) {
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    const status = await axios.get(`/api/export-status/${taskId}`);
                    if (status.data.status === 'success') {
                        this.showMessage('Export ready. Your CSV is downloading.', 'success');
                        window.location.href = `/api/export/${taskId}/download`;
                        return;
                    }
                    if (status.data.status === 'error') {
                        this.showMessage(status.data.message || 'Export failed', 'error');
                        return;
                    }
                }
                this.showMessage('Export is taking too long. Please try again.', 'error');
            } catch (error) {
                this.showMessage(errorMessage(error, 'Export failed'), 'error');
            } finally {
                this.exporting = false;
            }
        },
        elapsedMs(parkingTimestamp) {
            return Math.max(0, this.now - new Date(parkingTimestamp));
        },
        calculateCurrentDuration(parkingTimestamp) {
            const totalMinutes = Math.floor(this.elapsedMs(parkingTimestamp) / 60000);
            return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
        },
        formatTimer(parkingTimestamp) {
            const totalSeconds = Math.floor(this.elapsedMs(parkingTimestamp) / 1000);
            const pad = value => String(value).padStart(2, '0');
            return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}`;
        },
        billedHours(parkingTimestamp) {
            return Math.max(1, Math.ceil(this.elapsedMs(parkingTimestamp) / 3600000));
        },
        calculateCurrentCost(parkingTimestamp, pricePerHour) {
            return this.billedHours(parkingTimestamp) * (pricePerHour || 0);
        },
        formatStatus(status) {
            return status ? status.charAt(0).toUpperCase() + status.slice(1) : '';
        }
    },
    template: `
        <div class="min-vh-100 bg-light">
            <!-- Navbar -->
            <nav class="navbar navbar-expand-lg fixed-top">
                <div class="container">
                    <a class="navbar-brand" href="/">Parkit<span>V2</span></a>
                    <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#userNav" aria-controls="userNav" aria-expanded="false" aria-label="Toggle navigation">
                        <span class="navbar-toggler-icon"></span>
                    </button>
                    <div class="collapse navbar-collapse" id="userNav">
                        <ul class="navbar-nav mx-auto">
                            <li class="nav-item">
                                <a class="nav-link" :class="{active: currentSection === 'home'}" :aria-current="currentSection === 'home' ? 'page' : null" href="#" @click.prevent="switchSection('home')"><i class="bi bi-search me-2" aria-hidden="true"></i>Find parking</a>
                            </li>
                            <li class="nav-item">
                                <a class="nav-link" :class="{active: currentSection === 'history'}" :aria-current="currentSection === 'history' ? 'page' : null" href="#" @click.prevent="switchSection('history')"><i class="bi bi-clock-history me-2" aria-hidden="true"></i>My bookings</a>
                            </li>
                            <li class="nav-item">
                                <a class="nav-link" :class="{active: currentSection === 'charts'}" :aria-current="currentSection === 'charts' ? 'page' : null" href="#" @click.prevent="switchSection('charts')"><i class="bi bi-graph-up me-2" aria-hidden="true"></i>Stats</a>
                            </li>
                        </ul>
                        <div class="d-flex align-items-center gap-3 nav-actions">
                            <button type="button" class="avatar-button" aria-label="Profile settings" @click="switchSection('profile')">
                                <img :src="'/images/' + (user.avatar || 'avatar1.png')" class="nav-avatar" alt="">
                            </button>
                            <button @click="logout" class="btn btn-nano-outline btn-sm"><i class="bi bi-box-arrow-right me-2" aria-hidden="true"></i>Logout</button>
                        </div>
                    </div>
                </div>
            </nav>

            <main class="container dashboard-main">
                <!-- Alerts -->
                <div v-if="message" class="toast-area">
                    <div class="container">
                        <div class="alert shadow-sm mb-0 d-flex align-items-start justify-content-between gap-3" :class="alertClass" role="alert">
                            <span>{{ message }}</span>
                            <button type="button" class="btn-close" @click="message = ''" aria-label="Close"></button>
                        </div>
                    </div>
                </div>

                <!-- Home Section -->
                <div v-if="currentSection === 'home'">
                    <div class="mb-4">
                        <h1 class="h3 fw-bold mb-1">Hi {{ user.username }}</h1>
                        <p v-if="statsLoaded" class="text-muted mb-0">
                            <template v-if="stats.totalBookings">{{ stats.totalBookings }} {{ stats.totalBookings === 1 ? 'booking' : 'bookings' }} so far, {{ formatRupees(stats.totalSpent) }} spent in total.</template>
                            <template v-else>No bookings yet. Pick a location below to park.</template>
                        </p>
                    </div>

                    <!-- Active Session -->
                    <section v-if="activeBooking" class="feature-card session-card mb-5" aria-labelledby="sessionTitle">
                        <div class="row g-4 align-items-center">
                            <div class="col-lg-7">
                                <span class="session-label"><span class="live-dot" aria-hidden="true"></span>Active session</span>
                                <h2 id="sessionTitle" class="h4 fw-bold mt-2 mb-1">{{ activeBooking.lot_name }}</h2>
                                <p class="text-muted mb-3"><i class="bi bi-geo-alt me-1" aria-hidden="true"></i>{{ activeBooking.address }}</p>
                                <div class="d-flex flex-wrap gap-2">
                                    <span v-if="activeBooking.spot_number != null" class="session-chip"><i class="bi bi-p-square me-1" aria-hidden="true"></i>Spot {{ activeBooking.spot_number }}</span>
                                    <span class="session-chip"><i class="bi bi-car-front me-1" aria-hidden="true"></i>{{ activeBooking.vehicle_number }}</span>
                                    <span v-if="activeBooking.price_per_hour != null" class="session-chip"><i class="bi bi-tag me-1" aria-hidden="true"></i>{{ formatRate(activeBooking.price_per_hour) }}</span>
                                </div>
                            </div>
                            <div class="col-lg-5">
                                <div class="session-meter">
                                    <div class="d-flex flex-column flex-md-row justify-content-between align-items-center align-items-md-end gap-2 gap-md-3 text-center text-md-start">
                                        <div>
                                            <div class="small text-muted"><i class="bi bi-stopwatch me-1" aria-hidden="true"></i>Elapsed</div>
                                            <div class="session-timer">{{ formatTimer(activeBooking.parking_timestamp) }}</div>
                                        </div>
                                        <div class="text-center text-md-end">
                                            <div class="small text-muted">Cost so far</div>
                                            <div class="session-cost">{{ formatRupees(calculateCurrentCost(activeBooking.parking_timestamp, activeBooking.price_per_hour)) }}</div>
                                        </div>
                                    </div>
                                    <button @click="releaseSpot(activeBooking.id)" class="btn btn-nano-dark w-100 mt-3" :disabled="releasing">
                                        <span v-if="releasing" class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
                                        <i v-else class="bi bi-box-arrow-right me-2" aria-hidden="true"></i>End session
                                    </button>
                                </div>
                            </div>
                        </div>
                    </section>

                    <!-- Parking Locations -->
                    <div class="d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-3 mb-4">
                        <h4 class="fw-bold mb-0">Parking locations</h4>
                        <div class="search-box">
                            <label for="lotSearch" class="visually-hidden">Search locations</label>
                            <div class="input-group">
                                <span class="input-group-text"><i class="bi bi-search" aria-hidden="true"></i></span>
                                <input id="lotSearch" type="search" class="form-control border-start-0" v-model="lotSearch" placeholder="Search by name, address or PIN">
                            </div>
                        </div>
                    </div>
                    <p v-if="hasActiveBooking" class="small text-muted mb-3 mt-n2"><i class="bi bi-info-circle me-1" aria-hidden="true"></i>End your active session to book another spot.</p>
                    <div class="row g-4">
                        <div v-if="!lotsLoaded" class="col-12 text-center py-5 text-muted">
                            <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Loading locations...
                        </div>
                        <div v-else-if="filteredLots.length === 0" class="col-12 text-center py-5">
                            <p class="text-muted mb-0">{{ parkingLots.length === 0 ? 'No parking lots found.' : 'No locations match your search.' }}</p>
                        </div>
                        <div v-for="lot in filteredLots" :key="lot.id" class="col-md-6 col-lg-4">
                            <div class="feature-card h-100 d-flex flex-column" :class="{ 'lot-card-muted': hasActiveBooking || lot.available_spots === 0 }">
                                <div class="d-flex justify-content-between align-items-start gap-2 mb-3">
                                    <h5 class="fw-bold mb-0">{{ lot.prime_location_name }}</h5>
                                    <span class="badge bg-light text-dark border text-nowrap">{{ formatRate(lot.price) }}</span>
                                </div>
                                <p class="text-muted small flex-grow-1 mb-0"><i class="bi bi-geo-alt me-1" aria-hidden="true"></i>{{ lot.address }}, {{ lot.pin_code }}</p>
                                <div class="d-flex justify-content-between align-items-center mt-3">
                                    <span v-if="lot.available_spots === 0" class="badge rounded-pill badge-full">Full</span>
                                    <small v-else class="fw-bold spots-left"><i class="bi bi-p-square me-1" aria-hidden="true"></i>{{ lot.available_spots }} {{ lot.available_spots === 1 ? 'spot' : 'spots' }} left</small>
                                    <button @click="openBookingModal(lot)" class="btn btn-nano btn-sm px-4" :disabled="!reservationsLoaded || hasActiveBooking || lot.available_spots === 0" :aria-label="'Book a spot at ' + lot.prime_location_name">Book</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- History Section -->
                <div v-if="currentSection === 'history'">
                    <div class="d-flex justify-content-between align-items-center gap-3 mb-4">
                        <h4 class="fw-bold mb-0">Booking history</h4>
                        <button @click="exportCsv" class="btn btn-nano-outline btn-sm text-nowrap" :disabled="exporting">
                            <span v-if="exporting" class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
                            <i v-else class="bi bi-download me-2" aria-hidden="true"></i>{{ exporting ? 'Exporting...' : 'Export CSV' }}
                        </button>
                    </div>
                    <div class="card border-0 shadow-sm rounded-4 overflow-hidden">
                        <div class="table-responsive">
                            <table class="table table-hover mb-0 align-middle">
                                <thead class="bg-light">
                                    <tr>
                                        <th class="py-3 ps-3 ps-md-4">Location</th>
                                        <th class="py-3 d-none d-md-table-cell">Vehicle</th>
                                        <th class="py-3 d-none d-md-table-cell">Date</th>
                                        <th class="py-3">Duration</th>
                                        <th class="py-3">Cost</th>
                                        <th class="py-3">Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-if="!reservationsLoaded">
                                        <td colspan="6" class="text-center py-5 text-muted"><span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Loading bookings...</td>
                                    </tr>
                                    <tr v-else-if="reservations.length === 0">
                                        <td colspan="6" class="text-center py-5 text-muted">No bookings yet.</td>
                                    </tr>
                                    <tr v-for="res in reservations" :key="res.id">
                                        <td class="ps-3 ps-md-4">
                                            <div class="fw-bold">{{ res.lot_name }}</div>
                                            <div v-if="res.spot_number != null" class="small text-muted">Spot {{ res.spot_number }}</div>
                                            <div class="small text-muted d-md-none">{{ res.vehicle_number }}, {{ formatDateTime(res.parking_timestamp) }}</div>
                                        </td>
                                        <td class="text-nowrap d-none d-md-table-cell">{{ res.vehicle_number }}</td>
                                        <td class="text-muted text-nowrap d-none d-md-table-cell">{{ formatDateTime(res.parking_timestamp) }}</td>
                                        <td class="text-nowrap">{{ res.status === 'active' ? calculateCurrentDuration(res.parking_timestamp) : res.duration }}</td>
                                        <td class="fw-bold text-nowrap">{{ formatRupees(res.status === 'active' ? calculateCurrentCost(res.parking_timestamp, res.price_per_hour) : res.parking_cost) }}</td>
                                        <td>
                                            <span class="badge rounded-pill" :class="res.status === 'active' ? 'badge-open' : 'bg-light text-dark border'">
                                                {{ formatStatus(res.status) }}
                                            </span>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <!-- Stats Section -->
                <div v-if="currentSection === 'charts'">
                    <h4 class="fw-bold mb-4">My statistics</h4>
                    <div class="row g-3 g-lg-4 mb-4">
                        <div class="col-12 col-md-4">
                            <div class="feature-card stat-card">
                                <div>
                                    <p class="stat-label">Total spent</p>
                                    <p class="stat-value">{{ formatRupees(stats.totalSpent) }}</p>
                                </div>
                                <div class="feature-icon"><i class="bi bi-wallet2" aria-hidden="true"></i></div>
                            </div>
                        </div>
                        <div class="col-6 col-md-4">
                            <div class="feature-card stat-card">
                                <div>
                                    <p class="stat-label">Total bookings</p>
                                    <p class="stat-value">{{ stats.totalBookings }}</p>
                                </div>
                                <div class="feature-icon"><i class="bi bi-receipt" aria-hidden="true"></i></div>
                            </div>
                        </div>
                        <div class="col-6 col-md-4">
                            <div class="feature-card stat-card">
                                <div>
                                    <p class="stat-label">Avg per booking</p>
                                    <p class="stat-value">{{ formatRupees(averageCost) }}</p>
                                </div>
                                <div class="feature-icon"><i class="bi bi-cash-coin" aria-hidden="true"></i></div>
                            </div>
                        </div>
                    </div>
                    <div v-if="chartsLoading" class="chart-loading" role="status">
                        <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Loading charts...
                    </div>
                    <p v-else-if="!stats.lotUsage.length" class="chart-loading text-center p-4 mb-0">Your charts appear after your first completed booking.</p>
                    <div v-else class="row g-4">
                        <div class="col-lg-6">
                            <div class="feature-card h-100">
                                <h5 class="fw-bold mb-4">Spending by location</h5>
                                <div class="chart-box">
                                    <canvas id="userChart" aria-label="Spending by location" role="img"></canvas>
                                </div>
                            </div>
                        </div>
                        <div class="col-lg-6">
                            <div class="feature-card h-100">
                                <h5 class="fw-bold mb-4">Monthly spend, last 6 months</h5>
                                <div class="chart-box">
                                    <canvas id="monthlyChart" aria-label="Monthly spend over the last 6 months" role="img"></canvas>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Profile Section -->
                <div v-if="currentSection === 'profile'">
                    <div class="row justify-content-center">
                        <div class="col-md-8 col-lg-6">
                            <div class="feature-card">
                                <h4 class="fw-bold mb-4">Profile settings</h4>
                                <form @submit.prevent="updateProfile">
                                    <div class="mb-4 text-center">
                                        <p id="userAvatarLabel" class="form-label fw-semibold mb-3"><i class="bi bi-person-circle me-2" aria-hidden="true"></i>Choose avatar</p>
                                        <div class="d-flex justify-content-center gap-3 flex-wrap" role="group" aria-labelledby="userAvatarLabel">
                                            <button v-for="i in 4" :key="i" type="button"
                                                    class="avatar-option"
                                                    :class="{ selected: profileForm.avatar === 'avatar' + i + '.png' }"
                                                    :aria-pressed="profileForm.avatar === 'avatar' + i + '.png'"
                                                    :aria-label="'Avatar ' + i"
                                                    @click="profileForm.avatar = 'avatar' + i + '.png'">
                                                <img :src="'/images/avatar' + i + '.png'" alt="">
                                            </button>
                                        </div>
                                    </div>
                                    <div class="mb-3">
                                        <label for="userUsername" class="form-label fw-semibold">Username</label>
                                        <input id="userUsername" type="text" class="form-control" v-model="profileForm.username" autocomplete="username" required minlength="3" maxlength="30">
                                    </div>
                                    <div class="mb-3">
                                        <label for="userEmail" class="form-label fw-semibold">Email</label>
                                        <input id="userEmail" type="email" class="form-control" v-model="profileForm.email" autocomplete="email" required>
                                    </div>
                                    <hr class="my-4">
                                    <div class="mb-3">
                                        <label for="userCurrentPassword" class="form-label fw-semibold">Current password</label>
                                        <input id="userCurrentPassword" type="password" class="form-control" v-model="profileForm.currentPassword" autocomplete="current-password">
                                    </div>
                                    <div class="mb-3">
                                        <label for="userNewPassword" class="form-label fw-semibold">New password</label>
                                        <input id="userNewPassword" type="password" class="form-control" v-model="profileForm.newPassword" autocomplete="new-password">
                                    </div>
                                    <div class="mb-4">
                                        <label for="userConfirmPassword" class="form-label fw-semibold">Confirm password</label>
                                        <input id="userConfirmPassword" type="password" class="form-control" v-model="profileForm.confirmPassword" autocomplete="new-password">
                                    </div>
                                    <button type="submit" class="btn btn-nano w-100" :disabled="savingProfile">
                                        <span v-if="savingProfile" class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>{{ savingProfile ? 'Saving...' : 'Update profile' }}
                                    </button>
                                </form>
                            </div>
                        </div>
                    </div>
                </div>
            </main>

            <confirm-dialog :state="confirmState" @answer="answerConfirm"></confirm-dialog>

            <!-- Booking Modal -->
            <div v-if="showBookingModal" class="auth-modal-overlay show" @click.self="showBookingModal = false">
                <div class="auth-modal-content p-4" role="dialog" aria-modal="true" aria-labelledby="bookingModalTitle">
                    <button type="button" class="close-modal" @click="showBookingModal = false" aria-label="Close">&times;</button>
                    <h4 id="bookingModalTitle" class="fw-bold mb-4">Confirm booking</h4>
                    <div class="mb-3 p-3 bg-light rounded-3">
                        <h6 class="fw-bold mb-1">{{ bookingForm.lotName }}</h6>
                        <p class="text-muted small mb-2"><i class="bi bi-geo-alt me-1" aria-hidden="true"></i>{{ bookingForm.address }}</p>
                        <div class="fw-bold">{{ formatRate(bookingForm.price) }}<span class="fw-normal text-muted">, billed per started hour (1 hour minimum)</span></div>
                    </div>
                    <p class="small text-muted mb-4"><i class="bi bi-info-circle me-1" aria-hidden="true"></i>The first free spot is assigned automatically.</p>
                    <form @submit.prevent="bookSpot">
                        <div class="mb-4">
                            <label for="vehicleNumber" class="form-label">Vehicle number</label>
                            <input id="vehicleNumber" type="text" class="form-control form-control-lg vehicle-input" v-model="bookingForm.vehicleNumber" placeholder="e.g. MH12AB1234" autocomplete="off" required>
                        </div>
                        <div v-if="bookingError" class="alert alert-danger py-2" role="alert">{{ bookingError }}</div>
                        <button type="submit" class="btn btn-nano w-100 btn-lg" :disabled="booking">
                            <span v-if="booking" class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>{{ booking ? 'Booking...' : 'Confirm booking' }}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    `
};

if (window.location.pathname.startsWith('/user')) {
    Vue.createApp(userApp).mount('#app');
}
