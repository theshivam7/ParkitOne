const adminApp = {
    mixins: [dashboardMixin],
    data() {
        return {
            user: { id: null, username: '', email: '', avatar: '' },
            parkingLots: [],
            lotsLoaded: false,
            users: [],
            usersLoaded: false,
            userSearch: '',
            revenueToday: null,
            currentSection: 'home',
            message: '',
            messageType: '',
            showAddLotModal: false,
            showEditLotModal: false,
            showSpotsModal: false,
            lotFormError: '',
            savingLot: false,
            selectedLotId: null,
            parkingSpots: [],
            parkingLotForm: {
                prime_location_name: '',
                address: '',
                pin_code: '',
                price: '',
                number_of_spots: ''
            },
            editingLotId: null,
            profileForm: {
                username: '',
                avatar: '',
                currentPassword: '',
                newPassword: '',
                confirmPassword: ''
            },
            chartsLoading: false,
            chartData: {
                totalRevenue: 0,
                bookingsToday: 0,
                bookingsThisWeek: 0,
                lotRevenueData: [],
                dailyBookings: []
            }
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
        if (this.user.role !== 'admin') {
            window.location.href = '/user_dashboard';
            return;
        }
        this.loadAdminData();
    },
    computed: {
        selectedLot() {
            return this.parkingLots.find(lot => lot.id === this.selectedLotId) || null;
        },
        availableSpotCount() {
            return this.parkingSpots.filter(spot => spot.status === 'A').length;
        },
        occupiedSpotCount() {
            return this.parkingSpots.length - this.availableSpotCount;
        },
        totalAvailable() {
            return this.parkingLots.reduce((sum, lot) => sum + lot.available_spots, 0);
        },
        totalOccupied() {
            return this.parkingLots.reduce((sum, lot) => sum + (lot.number_of_spots - lot.available_spots), 0);
        },
        filteredUsers() {
            const query = this.userSearch.trim().toLowerCase();
            if (!query) return this.users;
            return this.users.filter(u =>
                u.username.toLowerCase().includes(query) || u.email.toLowerCase().includes(query));
        }
    },
    methods: {
        switchSection(section) {
            this.closeNav();
            this.destroyCharts();
            this.currentSection = section;
            this.message = '';
            if (section === 'home') {
                this.loadAdminData();
            } else if (section === 'users') {
                this.loadUsers();
            } else if (section === 'charts') {
                this.loadChartData();
            } else if (section === 'profile') {
                this.profileForm.username = this.user.username;
                this.profileForm.avatar = this.user.avatar || 'avatar3.png';
            }
        },
        closeModals() {
            if (this.showAddLotModal || this.showEditLotModal) this.closeLotModal();
            this.showSpotsModal = false;
        },
        async loadAdminData() {
            const [lots, stats] = await Promise.allSettled([
                axios.get('/api/parking-lots'),
                axios.get('/api/admin/dashboard-stats')
            ]);
            this.lotsLoaded = true;
            if (lots.status === 'fulfilled') {
                this.parkingLots = lots.value.data;
            } else {
                this.showMessage(errorMessage(lots.reason, 'Failed to load parking lots'), 'error');
            }
            if (stats.status === 'fulfilled') {
                this.revenueToday = stats.value.data.revenue_today ?? null;
            }
        },
        async loadUsers() {
            try {
                const response = await axios.get('/api/users');
                this.users = response.data;
            } catch (error) {
                this.showMessage(errorMessage(error, 'Failed to load users'), 'error');
            } finally {
                this.usersLoaded = true;
            }
        },
        async deleteUser(u) {
            if (!await this.askConfirm('Delete user', `Delete ${u.username}? This cannot be undone.`, 'Delete')) return;
            try {
                const response = await axios.delete(`/api/users/${u.id}`);
                this.showMessage(response.data.message, 'success');
                this.loadUsers();
            } catch (error) {
                this.showMessage(errorMessage(error, 'Failed to delete user'), 'error');
                this.loadUsers();
            }
        },
        async loadChartData() {
            this.chartsLoading = true;
            try {
                const [stats, lots, revenue] = await Promise.all([
                    axios.get('/api/admin/dashboard-stats'),
                    axios.get('/api/parking-lots'),
                    axios.get('/api/admin/parking-lots-revenue')
                ]);
                this.chartData.totalRevenue = stats.data.total_revenue || 0;
                this.chartData.bookingsToday = stats.data.bookings_today || 0;
                this.chartData.bookingsThisWeek = stats.data.bookings_this_week || 0;
                this.chartData.dailyBookings = stats.data.daily_bookings || [];
                this.parkingLots = lots.data;
                this.chartData.lotRevenueData = revenue.data;
                this.chartsLoading = false;
                this.$nextTick(this.renderCharts);
            } catch (error) {
                this.chartsLoading = false;
                this.showMessage(errorMessage(error, 'Failed to load chart data'), 'error');
            }
        },
        renderCharts() {
            const daily = this.chartData.dailyBookings;
            this.renderChart('bookings', 'bookingsChart', {
                type: 'line',
                data: {
                    labels: daily.map(day => day.label),
                    datasets: [{
                        label: 'Bookings',
                        data: daily.map(day => day.count),
                        borderColor: CHART_YELLOW,
                        backgroundColor: 'rgba(255, 215, 0, 0.15)',
                        borderWidth: 3,
                        fill: true,
                        cubicInterpolationMode: 'monotone',
                        pointBackgroundColor: CHART_DARK,
                        pointBorderColor: CHART_DARK,
                        pointRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { beginAtZero: true, suggestedMax: 4, ticks: { precision: 0 }, grid: { color: CHART_GRID } },
                        x: { grid: { display: false } }
                    }
                }
            });

            const revenueData = this.chartData.lotRevenueData;
            this.renderChart('revenue', 'revenueChart', {
                type: 'bar',
                data: {
                    labels: revenueData.map(lot => lot.location_name),
                    datasets: [{
                        label: 'Revenue (₹)',
                        data: revenueData.map(lot => lot.revenue),
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

            this.renderChart('occupancy', 'occupancyChart', {
                type: 'bar',
                data: {
                    labels: this.parkingLots.map(lot => lot.prime_location_name),
                    datasets: [
                        {
                            label: 'Available',
                            data: this.parkingLots.map(lot => lot.available_spots),
                            backgroundColor: CHART_YELLOW,
                            borderColor: CHART_DARK,
                            borderWidth: 2,
                            borderRadius: 4
                        },
                        {
                            label: 'Occupied',
                            data: this.parkingLots.map(lot => lot.number_of_spots - lot.available_spots),
                            backgroundColor: CHART_DARK,
                            borderColor: CHART_DARK,
                            borderWidth: 2,
                            borderRadius: 4
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'top' } },
                    scales: {
                        y: { beginAtZero: true, stacked: true, ticks: { precision: 0 }, grid: { color: CHART_GRID } },
                        x: { stacked: true, grid: { display: false } }
                    }
                }
            });
        },
        openAddLot() {
            this.parkingLotForm = { prime_location_name: '', address: '', pin_code: '', price: '', number_of_spots: '' };
            this.lotFormError = '';
            this.showAddLotModal = true;
            this.focusField('lotName');
        },
        openEditLot(lot) {
            this.parkingLotForm = { ...lot };
            this.editingLotId = lot.id;
            this.lotFormError = '';
            this.showEditLotModal = true;
            this.focusField('lotName');
        },
        closeLotModal() {
            this.showAddLotModal = false;
            this.showEditLotModal = false;
            this.editingLotId = null;
            this.lotFormError = '';
            this.parkingLotForm = { prime_location_name: '', address: '', pin_code: '', price: '', number_of_spots: '' };
        },
        async saveParkingLot() {
            this.lotFormError = '';
            this.savingLot = true;
            try {
                const response = this.showEditLotModal
                    ? await axios.put(`/api/parking-lots/${this.editingLotId}`, this.parkingLotForm)
                    : await axios.post('/api/parking-lots', this.parkingLotForm);
                this.closeLotModal();
                this.showMessage(response.data.message, 'success');
                this.loadAdminData();
            } catch (error) {
                this.lotFormError = errorMessage(error, 'Failed to save parking lot');
            } finally {
                this.savingLot = false;
            }
        },
        async deleteParkingLot(lot) {
            if (!await this.askConfirm('Delete location', `Delete ${lot.prime_location_name}? This cannot be undone.`, 'Delete')) return;
            try {
                const response = await axios.delete(`/api/parking-lots/${lot.id}`);
                this.showMessage(response.data.message, 'success');
                this.loadAdminData();
            } catch (error) {
                this.showMessage(errorMessage(error, 'Failed to delete parking lot'), 'error');
            }
        },
        async viewSpots(lotId) {
            try {
                const response = await axios.get(`/api/parking-spots/${lotId}`);
                this.parkingSpots = response.data;
                this.selectedLotId = lotId;
                this.showSpotsModal = true;
            } catch (error) {
                this.showMessage(errorMessage(error, 'Failed to load parking spots'), 'error');
            }
        },
        occupancyPercent(lot) {
            if (!lot.number_of_spots) return 0;
            return (lot.number_of_spots - lot.available_spots) / lot.number_of_spots * 100;
        },
        // Time only for today, otherwise date and time.
        formatSince(dateString) {
            const date = new Date(dateString);
            const day = value => value.toLocaleDateString('en-IN', { timeZone: TIME_ZONE });
            if (day(date) === day(new Date())) {
                return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TIME_ZONE });
            }
            return this.formatDateTime(dateString);
        },
        formatDate(dateString) {
            if (!dateString) return '-';
            return new Date(dateString).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: TIME_ZONE });
        }
    },
    template: `
        <div class="min-vh-100 bg-light">
            <!-- Navbar -->
            <nav class="navbar navbar-expand-lg fixed-top">
                <div class="container">
                    <a class="navbar-brand" href="/">Parkit<span>V2</span> <small class="text-muted fs-6 ms-2">Admin</small></a>
                    <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#adminNav" aria-controls="adminNav" aria-expanded="false" aria-label="Toggle navigation">
                        <span class="navbar-toggler-icon"></span>
                    </button>
                    <div class="collapse navbar-collapse" id="adminNav">
                        <ul class="navbar-nav mx-auto">
                            <li class="nav-item">
                                <a class="nav-link" :class="{active: currentSection === 'home'}" :aria-current="currentSection === 'home' ? 'page' : null" href="#" @click.prevent="switchSection('home')"><i class="bi bi-grid me-2" aria-hidden="true"></i>Dashboard</a>
                            </li>
                            <li class="nav-item">
                                <a class="nav-link" :class="{active: currentSection === 'users'}" :aria-current="currentSection === 'users' ? 'page' : null" href="#" @click.prevent="switchSection('users')"><i class="bi bi-people me-2" aria-hidden="true"></i>Users</a>
                            </li>
                            <li class="nav-item">
                                <a class="nav-link" :class="{active: currentSection === 'charts'}" :aria-current="currentSection === 'charts' ? 'page' : null" href="#" @click.prevent="switchSection('charts')"><i class="bi bi-bar-chart me-2" aria-hidden="true"></i>Analytics</a>
                            </li>
                        </ul>
                        <div class="d-flex align-items-center gap-3 nav-actions">
                            <button type="button" class="avatar-button" aria-label="Profile settings" @click="switchSection('profile')">
                                <img :src="'/images/' + (user.avatar || 'avatar3.png')" class="nav-avatar" alt="">
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

                <!-- Dashboard Home -->
                <div v-if="currentSection === 'home'">
                    <h1 class="visually-hidden">Admin dashboard</h1>
                    <div class="row g-3 g-lg-4 mb-5">
                        <div class="col-6 col-lg-3">
                            <div class="feature-card stat-card">
                                <div>
                                    <p class="stat-label">Lots</p>
                                    <p class="stat-value">{{ parkingLots.length }}</p>
                                </div>
                                <div class="feature-icon"><i class="bi bi-buildings" aria-hidden="true"></i></div>
                            </div>
                        </div>
                        <div class="col-6 col-lg-3">
                            <div class="feature-card stat-card">
                                <div>
                                    <p class="stat-label">Available</p>
                                    <p class="stat-value">{{ totalAvailable }}</p>
                                </div>
                                <div class="feature-icon"><i class="bi bi-p-square" aria-hidden="true"></i></div>
                            </div>
                        </div>
                        <div class="col-6 col-lg-3">
                            <div class="feature-card stat-card">
                                <div>
                                    <p class="stat-label">Occupied</p>
                                    <p class="stat-value">{{ totalOccupied }}</p>
                                </div>
                                <div class="feature-icon feature-icon-dark"><i class="bi bi-car-front-fill" aria-hidden="true"></i></div>
                            </div>
                        </div>
                        <div class="col-6 col-lg-3">
                            <div class="feature-card stat-card">
                                <div>
                                    <p class="stat-label">Revenue today</p>
                                    <p class="stat-value">{{ revenueToday === null ? '-' : formatRupees(revenueToday) }}</p>
                                </div>
                                <div class="feature-icon"><i class="bi bi-currency-rupee" aria-hidden="true"></i></div>
                            </div>
                        </div>
                    </div>

                    <div class="d-flex justify-content-between align-items-center gap-3 mb-4">
                        <h4 class="fw-bold mb-0">Parking locations</h4>
                        <button @click="openAddLot" class="btn btn-nano text-nowrap">
                            <i class="bi bi-plus-lg me-2" aria-hidden="true"></i>Add location
                        </button>
                    </div>

                    <div class="card border-0 shadow-sm rounded-4 overflow-hidden">
                        <div class="table-responsive">
                            <table class="table table-hover mb-0 align-middle">
                                <thead class="bg-light">
                                    <tr>
                                        <th class="py-3 ps-3 ps-md-4">Location</th>
                                        <th class="py-3 d-none d-md-table-cell">Address</th>
                                        <th class="py-3 d-none d-sm-table-cell">Price</th>
                                        <th class="py-3">Spots</th>
                                        <th class="py-3 d-none d-sm-table-cell">Status</th>
                                        <th class="py-3 text-end pe-3 pe-md-4">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-if="!lotsLoaded">
                                        <td colspan="6" class="text-center py-5 text-muted"><span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Loading locations...</td>
                                    </tr>
                                    <tr v-else-if="parkingLots.length === 0">
                                        <td colspan="6" class="text-center py-5 text-muted">No parking lots found. Add your first location to get started.</td>
                                    </tr>
                                    <tr v-for="lot in parkingLots" :key="lot.id">
                                        <td class="ps-3 ps-md-4">
                                            <div class="fw-bold">{{ lot.prime_location_name }}</div>
                                            <div class="small text-muted d-sm-none">{{ formatRate(lot.price) }}</div>
                                        </td>
                                        <td class="text-muted d-none d-md-table-cell">{{ lot.address }}</td>
                                        <td class="text-nowrap d-none d-sm-table-cell">{{ formatRate(lot.price) }}</td>
                                        <td>
                                            <div class="small fw-semibold text-nowrap">{{ lot.available_spots }} free of {{ lot.number_of_spots }}</div>
                                            <div class="progress occupancy-bar mt-1" role="progressbar" :aria-label="lot.prime_location_name + ' occupancy'" :aria-valuenow="Math.round(occupancyPercent(lot))" aria-valuemin="0" aria-valuemax="100">
                                                <div class="progress-bar" :style="{ width: occupancyPercent(lot) + '%' }"></div>
                                            </div>
                                        </td>
                                        <td class="d-none d-sm-table-cell">
                                            <span class="badge rounded-pill" :class="lot.available_spots > 0 ? 'badge-open' : 'badge-full'">
                                                {{ lot.available_spots > 0 ? 'Open' : 'Full' }}
                                            </span>
                                        </td>
                                        <td class="text-end pe-3 pe-md-4 text-nowrap">
                                            <button @click="viewSpots(lot.id)" class="btn btn-light icon-btn me-1" title="View spots" aria-label="View spots"><i class="bi bi-grid-3x3-gap" aria-hidden="true"></i></button>
                                            <button @click="openEditLot(lot)" class="btn btn-light icon-btn me-1" title="Edit" aria-label="Edit"><i class="bi bi-pencil" aria-hidden="true"></i></button>
                                            <button @click="deleteParkingLot(lot)" class="btn btn-light icon-btn text-danger" title="Delete" aria-label="Delete"><i class="bi bi-trash" aria-hidden="true"></i></button>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <!-- Users Section -->
                <div v-if="currentSection === 'users'">
                    <div class="d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-3 mb-4">
                        <h4 class="fw-bold mb-0">Registered users</h4>
                        <div class="search-box">
                            <label for="userSearch" class="visually-hidden">Search users</label>
                            <div class="input-group">
                                <span class="input-group-text"><i class="bi bi-search" aria-hidden="true"></i></span>
                                <input id="userSearch" type="search" class="form-control border-start-0" v-model="userSearch" placeholder="Search by username or email">
                            </div>
                        </div>
                    </div>
                    <div class="card border-0 shadow-sm rounded-4 overflow-hidden">
                        <div class="table-responsive">
                            <table class="table table-hover mb-0 align-middle">
                                <thead class="bg-light">
                                    <tr>
                                        <th class="py-3 ps-3 ps-md-4">User</th>
                                        <th class="py-3 d-none d-md-table-cell">Email</th>
                                        <th class="py-3 d-none d-lg-table-cell">Joined</th>
                                        <th class="py-3 d-none d-sm-table-cell">Bookings</th>
                                        <th class="py-3">Active booking</th>
                                        <th class="py-3 text-end pe-3 pe-md-4">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-if="!usersLoaded">
                                        <td colspan="6" class="text-center py-5 text-muted"><span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Loading users...</td>
                                    </tr>
                                    <tr v-else-if="filteredUsers.length === 0">
                                        <td colspan="6" class="text-center py-5 text-muted">{{ users.length === 0 ? 'No registered users yet.' : 'No users match your search.' }}</td>
                                    </tr>
                                    <tr v-for="u in filteredUsers" :key="u.id">
                                        <td class="ps-3 ps-md-4">
                                            <div class="d-flex align-items-center gap-2 gap-md-3">
                                                <img :src="'/images/' + (u.avatar || 'avatar1.png')" alt="" class="table-avatar">
                                                <div>
                                                    <div class="fw-bold">{{ u.username }}</div>
                                                    <div class="small text-muted text-break d-md-none">{{ u.email }}</div>
                                                </div>
                                            </div>
                                        </td>
                                        <td class="text-muted d-none d-md-table-cell">{{ u.email }}</td>
                                        <td class="text-nowrap d-none d-lg-table-cell">{{ formatDate(u.created_at) }}</td>
                                        <td class="d-none d-sm-table-cell">{{ u.total_reservations }}</td>
                                        <td>
                                            <template v-if="u.active_vehicle">
                                                <span class="badge badge-parked rounded-pill">{{ u.active_vehicle }}</span>
                                                <div class="small text-muted mt-1">{{ u.active_lot }}</div>
                                            </template>
                                            <span v-else class="text-muted">None</span>
                                        </td>
                                        <td class="text-end pe-3 pe-md-4">
                                            <span class="d-inline-block" :title="u.active_vehicle ? 'User is parked' : 'Delete user'">
                                                <button @click="deleteUser(u)" class="btn btn-light icon-btn text-danger" :disabled="!!u.active_vehicle" :aria-label="'Delete ' + u.username"><i class="bi bi-trash" aria-hidden="true"></i></button>
                                            </span>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <!-- Analytics Section -->
                <div v-if="currentSection === 'charts'">
                    <h4 class="fw-bold mb-4">Analytics</h4>

                    <div class="row g-3 g-lg-4 mb-4">
                        <div class="col-12 col-md-4">
                            <div class="feature-card stat-card">
                                <div>
                                    <p class="stat-label">Total revenue</p>
                                    <p class="stat-value">{{ formatRupees(chartData.totalRevenue) }}</p>
                                </div>
                                <div class="feature-icon"><i class="bi bi-currency-rupee" aria-hidden="true"></i></div>
                            </div>
                        </div>
                        <div class="col-6 col-md-4">
                            <div class="feature-card stat-card">
                                <div>
                                    <p class="stat-label">Bookings today</p>
                                    <p class="stat-value">{{ chartData.bookingsToday }}</p>
                                </div>
                                <div class="feature-icon"><i class="bi bi-calendar-day" aria-hidden="true"></i></div>
                            </div>
                        </div>
                        <div class="col-6 col-md-4">
                            <div class="feature-card stat-card">
                                <div>
                                    <p class="stat-label">Bookings this week</p>
                                    <p class="stat-value">{{ chartData.bookingsThisWeek }}</p>
                                </div>
                                <div class="feature-icon"><i class="bi bi-calendar-week" aria-hidden="true"></i></div>
                            </div>
                        </div>
                    </div>

                    <div v-if="chartsLoading" class="chart-loading" role="status">
                        <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Loading charts...
                    </div>
                    <template v-else>
                        <div class="feature-card mb-4">
                            <h5 class="fw-bold mb-4">Bookings, last 14 days</h5>
                            <div class="chart-box">
                                <canvas id="bookingsChart" aria-label="Daily bookings over the last 14 days" role="img"></canvas>
                            </div>
                        </div>
                        <div class="row g-4">
                            <div class="col-lg-6">
                                <div class="feature-card h-100">
                                    <h5 class="fw-bold mb-4">Revenue by location</h5>
                                    <div class="chart-box">
                                        <canvas id="revenueChart" aria-label="Revenue by location" role="img"></canvas>
                                    </div>
                                </div>
                            </div>
                            <div class="col-lg-6">
                                <div class="feature-card h-100">
                                    <h5 class="fw-bold mb-4">Occupancy</h5>
                                    <div class="chart-box">
                                        <canvas id="occupancyChart" aria-label="Available and occupied spots by location" role="img"></canvas>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </template>
                </div>

                <!-- Profile Section -->
                <div v-if="currentSection === 'profile'">
                    <div class="row justify-content-center">
                        <div class="col-md-8 col-lg-6">
                            <div class="feature-card">
                                <h4 class="fw-bold mb-4">Admin settings</h4>
                                <form @submit.prevent="updateProfile">
                                    <div class="mb-4 text-center">
                                        <p id="adminAvatarLabel" class="form-label fw-semibold mb-3"><i class="bi bi-person-circle me-2" aria-hidden="true"></i>Choose avatar</p>
                                        <div class="d-flex justify-content-center gap-3 flex-wrap" role="group" aria-labelledby="adminAvatarLabel">
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
                                        <label for="adminUsername" class="form-label fw-semibold">Username</label>
                                        <input id="adminUsername" type="text" class="form-control" v-model="profileForm.username" autocomplete="username" required minlength="3" maxlength="30">
                                    </div>
                                    <div class="mb-3">
                                        <label for="adminCurrentPassword" class="form-label fw-semibold">Current password</label>
                                        <input id="adminCurrentPassword" type="password" class="form-control" v-model="profileForm.currentPassword" autocomplete="current-password">
                                    </div>
                                    <div class="mb-3">
                                        <label for="adminNewPassword" class="form-label fw-semibold">New password</label>
                                        <input id="adminNewPassword" type="password" class="form-control" v-model="profileForm.newPassword" autocomplete="new-password">
                                    </div>
                                    <div class="mb-4">
                                        <label for="adminConfirmPassword" class="form-label fw-semibold">Confirm password</label>
                                        <input id="adminConfirmPassword" type="password" class="form-control" v-model="profileForm.confirmPassword" autocomplete="new-password">
                                    </div>
                                    <button type="submit" class="btn btn-nano w-100" :disabled="savingProfile">
                                        <span v-if="savingProfile" class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>{{ savingProfile ? 'Saving...' : 'Save changes' }}
                                    </button>
                                </form>
                            </div>
                        </div>
                    </div>
                </div>
            </main>

            <confirm-dialog :state="confirmState" @answer="answerConfirm"></confirm-dialog>

            <!-- Add / Edit Lot Modal -->
            <div v-if="showAddLotModal || showEditLotModal" class="auth-modal-overlay show" @click.self="closeLotModal">
                <div class="auth-modal-content p-4" role="dialog" aria-modal="true" aria-labelledby="lotModalTitle">
                    <button type="button" class="close-modal" @click="closeLotModal" aria-label="Close">&times;</button>
                    <h4 id="lotModalTitle" class="fw-bold mb-4">{{ showEditLotModal ? 'Edit location' : 'Add location' }}</h4>
                    <form @submit.prevent="saveParkingLot">
                        <div class="mb-3">
                            <label for="lotName" class="form-label">Location name</label>
                            <input id="lotName" type="text" class="form-control" v-model="parkingLotForm.prime_location_name" required>
                        </div>
                        <div class="mb-3">
                            <label for="lotAddress" class="form-label">Address</label>
                            <input id="lotAddress" type="text" class="form-control" v-model="parkingLotForm.address" required>
                        </div>
                        <div class="row">
                            <div class="col-6 mb-3">
                                <label for="lotPin" class="form-label">Pin code</label>
                                <input id="lotPin" type="text" class="form-control" v-model="parkingLotForm.pin_code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" title="6 digit pin code" required>
                            </div>
                            <div class="col-6 mb-3">
                                <label for="lotPrice" class="form-label">Price per hour (₹)</label>
                                <input id="lotPrice" type="number" class="form-control" v-model="parkingLotForm.price" min="1" step="0.01" required>
                            </div>
                        </div>
                        <div class="mb-4">
                            <label for="lotSpots" class="form-label">Total spots</label>
                            <input id="lotSpots" type="number" class="form-control" v-model="parkingLotForm.number_of_spots" min="1" max="500" step="1" required>
                        </div>
                        <div v-if="lotFormError" class="alert alert-danger py-2" role="alert">{{ lotFormError }}</div>
                        <button type="submit" class="btn btn-nano w-100" :disabled="savingLot">
                            <span v-if="savingLot" class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>{{ showEditLotModal ? 'Update location' : 'Create location' }}
                        </button>
                    </form>
                </div>
            </div>

            <!-- View Spots Modal -->
            <div v-if="showSpotsModal" class="auth-modal-overlay show" @click.self="showSpotsModal = false">
                <div class="auth-modal-content spots-modal p-4 d-flex flex-column" role="dialog" aria-modal="true" aria-labelledby="spotsModalTitle">
                    <button type="button" class="close-modal" @click="showSpotsModal = false" aria-label="Close">&times;</button>
                    <div class="mb-3 pe-4">
                        <h4 id="spotsModalTitle" class="fw-bold mb-2">{{ selectedLot ? selectedLot.prime_location_name : 'Parking spots' }}</h4>
                        <div class="d-flex flex-wrap align-items-center gap-3 small">
                            <span><span class="legend-swatch spot-available" aria-hidden="true"></span>Available {{ availableSpotCount }}</span>
                            <span><span class="legend-swatch spot-occupied" aria-hidden="true"></span>Occupied {{ occupiedSpotCount }}</span>
                            <span class="text-muted">Total {{ parkingSpots.length }}</span>
                        </div>
                    </div>

                    <div class="flex-grow-1 spots-scroll">
                        <p v-if="parkingSpots.length === 0" class="text-center py-5 text-muted mb-0">No spots found for this location.</p>
                        <ul v-else class="spot-grid">
                            <li v-for="spot in parkingSpots" :key="spot.id" class="spot-tile" :class="spot.status === 'A' ? 'spot-available' : 'spot-occupied'">
                                <div class="spot-number">{{ spot.spot_number }}</div>
                                <template v-if="spot.status === 'O'">
                                    <div class="spot-vehicle">{{ spot.vehicle_number }}</div>
                                    <div class="spot-meta">{{ spot.username }}</div>
                                    <div class="spot-meta">Since {{ formatSince(spot.parking_timestamp) }}</div>
                                </template>
                                <div v-else class="spot-meta">Free</div>
                            </li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    `
};

if (window.location.pathname.startsWith('/admin')) {
    Vue.createApp(adminApp).mount('#app');
}
