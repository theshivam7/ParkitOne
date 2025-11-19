const authApp = {
    data() {
        return {
            showAuth: false,
            activeTab: 'login',
            user: null,
            parkedCars: [
                { spot: 1, color: '#F4F4F5' }, { spot: 2, color: '#9CA3AF' }, { spot: 4, color: '#FFFFFF' },
                { spot: 5, color: '#D4D4D8' }, { spot: 8, color: '#F4F4F5' }
            ],
            loginForm: {
                username: '',
                password: ''
            },
            registerForm: {
                username: '',
                email: '',
                password: ''
            },
            message: '',
            messageType: '',
            submitting: false,
            registerTimer: null,
            currentYear: new Date().getFullYear(),
            lots: []
        }
    },
    computed: {
        totalFree() {
            return this.lots.reduce((sum, lot) => sum + lot.available_spots, 0);
        }
    },
    mounted() {
        this.checkLoginStatus();
        this.loadLots();
        this.onKeydown = event => {
            if (event.key === 'Escape' && this.showAuth) this.closeAuth();
        };
        document.addEventListener('keydown', this.onKeydown);
    },
    beforeUnmount() {
        document.removeEventListener('keydown', this.onKeydown);
        clearTimeout(this.registerTimer);
    },
    methods: {
        closeNav,
        openAuth(tab) {
            this.closeNav();
            this.activeTab = tab;
            this.showAuth = true;
            this.message = '';
            this.focusFirstField();
        },
        switchTab(tab) {
            clearTimeout(this.registerTimer);
            this.activeTab = tab;
            this.message = '';
            this.focusFirstField();
        },
        focusFirstField() {
            this.$nextTick(() => document.getElementById(this.activeTab === 'login' ? 'loginUsername' : 'registerUsername')?.focus());
        },
        closeAuth() {
            this.showAuth = false;
            clearTimeout(this.registerTimer);
            this.loginForm = { username: '', password: '' };
            this.registerForm = { username: '', email: '', password: '' };
            this.message = '';
        },
        // A 401 here just means nobody is signed in.
        async loadLots() {
            try {
                const response = await axios.get('/api/parking-lots');
                this.lots = response.data;
            } catch (error) {
                this.lots = [];
            }
        },
        async checkLoginStatus() {
            try {
                const response = await axios.get('/api/current-user');
                this.user = response.data;
            } catch (error) {}
        },
        async handleLogin() {
            this.submitting = true;
            try {
                const response = await axios.post('/api/login', this.loginForm);
                // The button stays disabled until the new page loads.
                window.location.href = response.data.role === 'admin' ? '/admin_dashboard' : '/user_dashboard';
            } catch (error) {
                this.message = error.response?.data?.message || 'Login failed';
                this.messageType = 'error';
                this.submitting = false;
            }
        },
        async handleRegister() {
            this.submitting = true;
            try {
                const response = await axios.post('/api/register', this.registerForm);
                this.message = response.data.message;
                this.messageType = 'success';
                this.loginForm.username = this.registerForm.username;
                this.registerForm = { username: '', email: '', password: '' };
                this.registerTimer = setTimeout(() => {
                    this.activeTab = 'login';
                    this.$nextTick(() => document.getElementById('loginPassword')?.focus());
                }, 1500);
            } catch (error) {
                this.message = error.response?.data?.message || 'Registration failed';
                this.messageType = 'error';
            } finally {
                this.submitting = false;
            }
        },
        async logout() {
            try {
                await axios.post('/api/logout');
            } finally {
                window.location.href = '/';
            }
        }
    },
    template: `
        <div>
            <!-- Navbar -->
            <nav class="navbar navbar-expand-lg fixed-top">
                <div class="container">
                    <a class="navbar-brand" href="/">Parkit<span>V2</span></a>
                    <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav" aria-controls="navbarNav" aria-expanded="false" aria-label="Toggle navigation">
                        <span class="navbar-toggler-icon"></span>
                    </button>
                    <div class="collapse navbar-collapse" id="navbarNav">
                        <ul class="navbar-nav ms-auto align-items-center">
                            <li class="nav-item">
                                <a class="nav-link" href="#features" @click="closeNav">How it works</a>
                            </li>
                            
                            <!-- Dashboard Link (Logged In) -->
                            <template v-if="user">
                                <li class="nav-item">
                                    <a class="nav-link" :href="user.role === 'admin' ? '/admin_dashboard' : '/user_dashboard'">
                                        <i class="bi bi-speedometer2 me-1" aria-hidden="true"></i>Dashboard
                                    </a>
                                </li>
                            </template>
                            
                            <!-- Auth Buttons (Not Logged In) -->
                            <template v-if="!user">
                                <li class="nav-item ms-lg-3">
                                    <button @click="openAuth('login')" class="btn btn-nano-outline me-2">Sign in</button>
                                </li>
                                <li class="nav-item">
                                    <button @click="openAuth('register')" class="btn btn-nano">Sign up</button>
                                </li>
                            </template>

                            <!-- Logout Button (Logged In) -->
                            <template v-else>
                                <li class="nav-item ms-lg-3">
                                    <button @click="logout" class="btn btn-nano-outline"><i class="bi bi-box-arrow-right me-2" aria-hidden="true"></i>Logout</button>
                                </li>
                            </template>
                        </ul>
                    </div>
                </div>
            </nav>

            <!-- Hero Section -->
            <section class="hero-section">
                <div class="hero-blob"></div>
                <div class="hero-particles"></div>
                <div class="container">
                    <div class="row align-items-center">
                        <div class="col-lg-6">
                            <h1 class="hero-title hero-font">Park Smarter,<br>Not Harder.</h1>
                            <p class="hero-subtitle">See free spots in every lot, book with your vehicle number, and pay only for the time you park.</p>
                            <div class="d-flex gap-3 hero-actions">
                                <button v-if="!user" @click="openAuth('register')" class="btn btn-nano btn-lg">Get started</button>
                                <a v-else :href="user.role === 'admin' ? '/admin_dashboard' : '/user_dashboard'" class="btn btn-nano btn-lg">Go to dashboard</a>
                                <a href="#features" class="btn btn-nano-outline btn-lg">Learn more</a>
                            </div>
                            <p v-if="lots.length" class="hero-live">
                                <span class="live-dot" aria-hidden="true"></span>
                                {{ totalFree }} free {{ totalFree === 1 ? 'spot' : 'spots' }} across {{ lots.length }} {{ lots.length === 1 ? 'lot' : 'lots' }} right now
                            </p>
                        </div>
                        <div class="col-lg-6 mt-5 mt-lg-0">
                            <div class="hero-image-container">
                                <div class="lot-board" role="img" aria-label="A car being guided into the first free spot of a parking lot">
                                    <div class="lot-head">
                                        <span class="fw-bold">Connaught Place</span>
                                        <span class="lot-free">2 free</span>
                                    </div>
                                    <div class="lot-area">
                                        <div v-for="n in 8" :key="n" class="lot-spot" :class="[n <= 4 ? 'lot-spot-top' : 'lot-spot-bottom', 'lot-col-' + ((n - 1) % 4), { 'lot-spot-target': n === 3 }]">
                                            <span class="lot-num">{{ n }}</span>
                                        </div>
                                        <div class="lot-lane"></div>
                                        <div v-for="c in parkedCars" :key="c.spot" class="lot-car" :class="['lot-col-' + ((c.spot - 1) % 4), c.spot <= 4 ? 'lot-car-top' : 'lot-car-bottom']" :style="{ '--car': c.color }"></div>
                                        <div class="lot-car lot-car-arriving" style="--car: #FFD700;"></div>
                                    </div>
                                    <div class="lot-ticket">
                                        <span class="lot-ticket-icon"><i class="bi bi-check-lg" aria-hidden="true"></i></span>
                                        <div>
                                            <div class="fw-bold">Spot 3 assigned</div>
                                            <small class="text-muted">DL01AB1234, ₹50/hr</small>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <!-- Features Section -->
            <section id="features" class="features-section" aria-labelledby="featuresTitle">
                <div class="container">
                    <h2 id="featuresTitle" class="fw-bold text-center mb-5">How it works</h2>
                    <div class="row g-4">
                        <div class="col-md-4">
                            <div class="feature-card">
                                <div class="d-flex justify-content-between align-items-start">
                                    <div class="feature-icon">
                                        <i class="bi bi-geo-alt" aria-hidden="true"></i>
                                    </div>
                                    <span class="step-num">Step 1</span>
                                </div>
                                <h3>Pick a lot</h3>
                                <p class="text-muted mb-0">See live free spots and the hourly rate for every location before you head out.</p>
                            </div>
                        </div>
                        <div class="col-md-4">
                            <div class="feature-card">
                                <div class="d-flex justify-content-between align-items-start">
                                    <div class="feature-icon">
                                        <i class="bi bi-car-front" aria-hidden="true"></i>
                                    </div>
                                    <span class="step-num">Step 2</span>
                                </div>
                                <h3>Book a spot</h3>
                                <p class="text-muted mb-0">Enter your vehicle number and the first free spot in the lot is assigned to you.</p>
                            </div>
                        </div>
                        <div class="col-md-4">
                            <div class="feature-card">
                                <div class="d-flex justify-content-between align-items-start">
                                    <div class="feature-icon">
                                        <i class="bi bi-receipt" aria-hidden="true"></i>
                                    </div>
                                    <span class="step-num">Step 3</span>
                                </div>
                                <h3>End the session</h3>
                                <p class="text-muted mb-0">Pay only for the time you parked. Your history, charts and CSV export stay in your dashboard.</p>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <!-- Footer -->
            <footer class="footer">
                <div class="container">
                    <div class="footer-cta">
                        <div>
                            <h2 class="h4 fw-bold mb-1">Find a spot in under a minute.</h2>
                            <p class="mb-0 text-white-50">Pick a lot, enter your vehicle number, and park.</p>
                        </div>
                        <button v-if="!user" type="button" class="btn btn-nano" @click="openAuth('register')">Create an account</button>
                        <a v-else :href="user.role === 'admin' ? '/admin_dashboard' : '/user_dashboard'" class="btn btn-nano">Go to dashboard</a>
                    </div>

                    <div class="row gy-4 py-5">
                        <div class="col-lg-5">
                            <a href="/" class="footer-logo">Parkit<span>V2</span></a>
                            <p class="footer-text">A parking app for 4-wheelers: live free spots, automatic spot assignment, and pay for the time you park.</p>
                        </div>
                        <div class="col-6 col-lg-2 offset-lg-1">
                            <h3 class="footer-heading">Explore</h3>
                            <ul class="footer-links">
                                <li><a href="#features">How it works</a></li>
                                <template v-if="!user">
                                    <li><button type="button" @click="openAuth('login')">Sign in</button></li>
                                    <li><button type="button" @click="openAuth('register')">Sign up</button></li>
                                </template>
                            </ul>
                        </div>
                        <div class="col-6 col-lg-2">
                            <h3 class="footer-heading">Project</h3>
                            <ul class="footer-links">
                                <li><a href="https://github.com/theshivam7/ParkitOne" target="_blank" rel="noopener">Source code</a></li>
                                <li><a href="https://study.iitm.ac.in/ds/course_pages/BSCS2006P.html" target="_blank" rel="noopener">IITM MAD II</a></li>
                            </ul>
                        </div>
                        <div class="col-lg-2">
                            <h3 class="footer-heading">Connect</h3>
                            <div class="d-flex gap-2">
                                <a href="https://github.com/theshivam7/ParkitOne" class="footer-social" target="_blank" rel="noopener" aria-label="GitHub"><i class="bi bi-github" aria-hidden="true"></i></a>
                                <a href="https://www.linkedin.com/in/theshivam7/" class="footer-social" target="_blank" rel="noopener" aria-label="LinkedIn"><i class="bi bi-linkedin" aria-hidden="true"></i></a>
                                <a href="https://x.com/thexshivam" class="footer-social" target="_blank" rel="noopener" aria-label="X"><i class="bi bi-twitter-x" aria-hidden="true"></i></a>
                            </div>
                        </div>
                    </div>

                    <div class="footer-bottom">
                        <span>&copy; {{ currentYear }} Parkit V2</span>
                        <span>Built by <a href="https://www.linkedin.com/in/theshivam7/" target="_blank" rel="noopener">Shivam Sharma</a></span>
                    </div>
                </div>
            </footer>

            <!-- Auth Modal -->
            <div class="auth-modal-overlay" :class="{ 'show': showAuth }" @click.self="closeAuth">
                <div class="auth-modal-content" role="dialog" aria-modal="true" aria-labelledby="authModalTitle">
                    <h2 id="authModalTitle" class="visually-hidden">{{ activeTab === 'login' ? 'Sign in' : 'Create an account' }}</h2>
                    <button type="button" class="close-modal" @click="closeAuth" aria-label="Close">&times;</button>

                    <div class="auth-tabs">
                        <button type="button" class="auth-tab" :class="{ active: activeTab === 'login' }" :aria-pressed="activeTab === 'login'" @click="switchTab('login')">
                            Sign in
                        </button>
                        <button type="button" class="auth-tab" :class="{ active: activeTab === 'register' }" :aria-pressed="activeTab === 'register'" @click="switchTab('register')">
                            Sign up
                        </button>
                    </div>

                    <div class="auth-body">
                        <!-- Login Form -->
                        <form v-if="activeTab === 'login'" @submit.prevent="handleLogin">
                            <div class="mb-3">
                                <label for="loginUsername" class="form-label">Username or email</label>
                                <div class="input-group">
                                    <span class="input-group-text"><i class="bi bi-person" aria-hidden="true"></i></span>
                                    <input id="loginUsername" type="text" class="form-control border-start-0" v-model="loginForm.username" placeholder="Enter username or email" autocomplete="username" required>
                                </div>
                            </div>
                            <div class="mb-4">
                                <label for="loginPassword" class="form-label">Password</label>
                                <div class="input-group">
                                    <span class="input-group-text"><i class="bi bi-lock" aria-hidden="true"></i></span>
                                    <input id="loginPassword" type="password" class="form-control border-start-0" v-model="loginForm.password" placeholder="Enter password" autocomplete="current-password" required>
                                </div>
                            </div>
                            <button type="submit" class="btn btn-nano w-100" :disabled="submitting">
                                <span v-if="submitting" class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Sign in
                            </button>
                        </form>

                        <!-- Register Form -->
                        <form v-if="activeTab === 'register'" @submit.prevent="handleRegister">
                            <div class="mb-3">
                                <label for="registerUsername" class="form-label">Username</label>
                                <div class="input-group">
                                    <span class="input-group-text"><i class="bi bi-person" aria-hidden="true"></i></span>
                                    <input id="registerUsername" type="text" class="form-control border-start-0" v-model="registerForm.username" placeholder="Choose username" autocomplete="username" required minlength="3" maxlength="30">
                                </div>
                            </div>
                            <div class="mb-3">
                                <label for="registerEmail" class="form-label">Email</label>
                                <div class="input-group">
                                    <span class="input-group-text"><i class="bi bi-envelope" aria-hidden="true"></i></span>
                                    <input id="registerEmail" type="email" class="form-control border-start-0" v-model="registerForm.email" placeholder="Enter email" autocomplete="email" required>
                                </div>
                            </div>
                            <div class="mb-4">
                                <label for="registerPassword" class="form-label">Password</label>
                                <div class="input-group">
                                    <span class="input-group-text"><i class="bi bi-lock" aria-hidden="true"></i></span>
                                    <input id="registerPassword" type="password" class="form-control border-start-0" v-model="registerForm.password" placeholder="Create password" autocomplete="new-password" aria-describedby="registerPasswordHint" required minlength="6">
                                </div>
                                <div id="registerPasswordHint" class="form-text">At least 6 characters</div>
                            </div>
                            <button type="submit" class="btn btn-nano w-100" :disabled="submitting">
                                <span v-if="submitting" class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Create account
                            </button>
                        </form>

                        <!-- Message Alert -->
                        <div v-if="message" class="alert mt-3 mb-0" :class="{'alert-success': messageType === 'success', 'alert-danger': messageType === 'error'}" role="alert">
                            {{ message }}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `
};

if (window.location.pathname === '/') {
    Vue.createApp(authApp).mount('#app');
}