// Helpers shared by the landing page and both dashboards.

// An expired or invalid session on a dashboard sends the user back to the landing page.
axios.interceptors.response.use(
    response => response,
    error => {
        if (error.response?.status === 401 && window.location.pathname !== '/') {
            window.location.href = '/';
        }
        return Promise.reject(error);
    }
);

// Theme colors for Chart.js, which cannot read CSS variables.
const CHART_YELLOW = '#FFD700';
const CHART_DARK = '#1A1A1A';
const CHART_GRID = '#f0f0f0';

// Times are shown in IST, matching the CSV export and the server's daily and monthly totals.
const TIME_ZONE = 'Asia/Kolkata';

Chart.defaults.font.family = "'Outfit', sans-serif";
Chart.defaults.color = '#555';

// Collapse the mobile navbar after a menu choice.
function closeNav() {
    const el = document.querySelector('.navbar-collapse.show');
    if (el) bootstrap.Collapse.getOrCreateInstance(el).hide();
}

function errorMessage(error, fallback) {
    return error.response?.data?.message || fallback;
}

// Themed replacement for window.confirm(), driven by dashboardMixin.askConfirm().
const ConfirmDialog = {
    props: ['state'],
    emits: ['answer'],
    template: `
        <div v-if="state" class="auth-modal-overlay show" @click.self="$emit('answer', false)">
            <div class="auth-modal-content p-4 confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmTitle" aria-describedby="confirmText">
                <h5 id="confirmTitle" class="fw-bold mb-2">{{ state.title }}</h5>
                <p id="confirmText" class="text-muted mb-4">{{ state.text }}</p>
                <div class="d-flex justify-content-end gap-2">
                    <button id="confirmCancel" type="button" class="btn btn-nano-outline btn-sm" @click="$emit('answer', false)">Cancel</button>
                    <button type="button" class="btn btn-nano-dark btn-sm" @click="$emit('answer', true)">{{ state.confirmLabel }}</button>
                </div>
            </div>
        </div>
    `
};

// Each app using this mixin defines closeModals().
const dashboardMixin = {
    components: { ConfirmDialog },
    data() {
        return {
            savingProfile: false,
            charts: {},
            confirmState: null,
            messageTimer: null
        };
    },
    mounted() {
        this.onKeydown = event => {
            if (event.key !== 'Escape') return;
            if (this.confirmState) this.answerConfirm(false);
            else this.closeModals();
        };
        document.addEventListener('keydown', this.onKeydown);
    },
    computed: {
        alertClass() {
            return { success: 'alert-success', error: 'alert-danger', info: 'alert-nano' }[this.messageType];
        }
    },
    beforeUnmount() {
        document.removeEventListener('keydown', this.onKeydown);
        clearTimeout(this.messageTimer);
        this.destroyCharts();
    },
    methods: {
        closeNav,
        showMessage(text, type) {
            clearTimeout(this.messageTimer);
            this.message = text;
            this.messageType = type;
            if (type === 'success') {
                this.messageTimer = setTimeout(() => { this.message = ''; }, 4000);
            }
        },
        askConfirm(title, text, confirmLabel) {
            return new Promise(resolve => {
                this.confirmState = { title, text, confirmLabel, resolve };
                this.$nextTick(() => document.getElementById('confirmCancel')?.focus());
            });
        },
        answerConfirm(confirmed) {
            const state = this.confirmState;
            this.confirmState = null;
            if (state) state.resolve(confirmed);
        },
        focusField(id) {
            this.$nextTick(() => document.getElementById(id)?.focus());
        },
        formatRupees(value) {
            return '₹' + Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        },
        formatDateTime(dateString) {
            if (!dateString) return '-';
            return new Date(dateString).toLocaleString('en-IN', {
                day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TIME_ZONE
            });
        },
        // Hourly rates drop the decimals only when they are whole rupees.
        formatRate(value) {
            const price = Number(value || 0);
            return '₹' + price.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(price) ? 0 : 2, maximumFractionDigits: 2 }) + '/hr';
        },
        async logout() {
            try {
                await axios.post('/api/logout');
            } finally {
                window.location.href = '/';
            }
        },
        // Chart instances stay out of Vue reactivity, which would otherwise proxy their internals.
        renderChart(key, canvasId, config) {
            const canvas = document.getElementById(canvasId);
            if (!canvas) return;
            if (this.charts[key]) this.charts[key].destroy();
            this.charts[key] = Vue.markRaw(new Chart(canvas, config));
        },
        destroyCharts() {
            Object.values(this.charts).forEach(chart => chart.destroy());
            this.charts = {};
        },
        async updateProfile() {
            const { confirmPassword, ...payload } = this.profileForm;
            if (payload.newPassword && payload.newPassword !== confirmPassword) {
                return this.showMessage('Passwords do not match', 'error');
            }
            if (payload.newPassword && !payload.currentPassword) {
                return this.showMessage('Enter your current password to set a new one', 'error');
            }
            this.savingProfile = true;
            try {
                const response = await axios.put(`/api/user/profile/${this.user.id}`, payload);
                Object.assign(this.user, response.data.user);
                // The server trims names and lowercases emails.
                this.profileForm.username = this.user.username;
                if ('email' in this.profileForm) this.profileForm.email = this.user.email;
                this.profileForm.currentPassword = '';
                this.profileForm.newPassword = '';
                this.profileForm.confirmPassword = '';
                this.showMessage(response.data.message, 'success');
            } catch (error) {
                this.showMessage(errorMessage(error, 'Failed to update profile'), 'error');
            } finally {
                this.savingProfile = false;
            }
        }
    }
};
