from flask import Flask
from flask_session import Session
from flask_mail import Mail
from flask_caching import Cache
from datetime import timedelta
from sqlalchemy.exc import IntegrityError, OperationalError
from backend.models.models import db, User, ParkingLot, ParkingSpot, Reservation, utcnow, billed_hours
from backend.routes.routes import register_routes
from backend.tasks import init_celery
import logging
import os
import redis

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
static_dir = os.path.join(project_root, 'frontend', 'src', 'components')

app = Flask(__name__, static_folder=static_dir, static_url_path='/static')
app.logger.setLevel(logging.INFO)

IS_VERCEL = bool(os.environ.get('VERCEL'))
REDIS_URL = os.environ.get('REDIS_URL', 'redis://localhost:6379/0')

app.config['VERCEL'] = IS_VERCEL
app.config['REDIS_URL'] = REDIS_URL
app.config['APP_URL'] = os.environ.get('APP_URL', 'http://127.0.0.1:8000').rstrip('/')
app.config['CRON_SECRET'] = os.environ.get('CRON_SECRET')
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')
if IS_VERCEL and not os.environ.get('SECRET_KEY'):
    app.logger.warning('SECRET_KEY is not set; using the insecure development key')

# Database: Vercel only allows writes under /tmp
if IS_VERCEL:
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:////tmp/parking.db'
else:
    instance_dir = os.path.join(project_root, 'instance')
    os.makedirs(instance_dir, exist_ok=True)
    app.config['SQLALCHEMY_DATABASE_URI'] = f"sqlite:///{os.path.join(instance_dir, 'parking.db')}"
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# One Redis URL (hosted plans often allow only db 0); sessions and cache use separate key prefixes
app.config['SESSION_TYPE'] = 'redis'
app.config['SESSION_REDIS'] = redis.from_url(REDIS_URL)
app.config['SESSION_KEY_PREFIX'] = 'parkit_v2:session:'
app.config['SESSION_PERMANENT'] = False
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(hours=24)
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_SECURE'] = IS_VERCEL

app.config['CACHE_TYPE'] = 'RedisCache'
app.config['CACHE_REDIS_URL'] = REDIS_URL
# Each Vercel deployment has its own database, so deployments must not share cached responses
deployment_id = os.environ.get('VERCEL_DEPLOYMENT_ID', '')
app.config['CACHE_KEY_PREFIX'] = f'parkit_v2:cache:{deployment_id}:' if deployment_id else 'parkit_v2:cache:'

# Emails are skipped when MAIL_USERNAME is unset
app.config['MAIL_SERVER'] = os.environ.get('MAIL_SERVER', 'smtp.gmail.com')
app.config['MAIL_PORT'] = int(os.environ.get('MAIL_PORT', 587))
app.config['MAIL_USE_TLS'] = os.environ.get('MAIL_USE_TLS', 'true').lower() in ('1', 'true', 'yes')
app.config['MAIL_USERNAME'] = os.environ.get('MAIL_USERNAME')
app.config['MAIL_PASSWORD'] = os.environ.get('MAIL_PASSWORD')
app.config['MAIL_DEFAULT_SENDER'] = os.environ.get('MAIL_DEFAULT_SENDER', app.config['MAIL_USERNAME'])
# Optional comma separated allowlist, e.g. for a public demo
app.config['MAIL_ALLOWED_DOMAINS'] = [d.strip().lower() for d in os.environ.get('MAIL_ALLOWED_DOMAINS', '').split(',') if d.strip()]

app.config['ADMIN_PASSWORD'] = os.environ.get('ADMIN_PASSWORD', 'admin123')

Session(app)
Mail(app)
cache = Cache(app)
celery_app = init_celery(app)

# (name, address, pin, price per hour, spots)
SEED_LOTS = [
    ('Connaught Place', 'Inner Circle, Connaught Place, New Delhi', '110001', 50.0, 20),
    ('Saket Mall', 'District Centre, Saket, New Delhi', '110017', 40.0, 15),
    ('India Gate', 'Kartavya Path, New Delhi', '110003', 60.0, 25),
    ('Hauz Khas Village', 'Hauz Khas Village Road, New Delhi', '110016', 40.0, 18),
    ('Karol Bagh Market', 'Ajmal Khan Road, Karol Bagh, New Delhi', '110005', 30.0, 30),
    ('Chandni Chowk', 'Near Red Fort, Chandni Chowk, Delhi', '110006', 35.0, 22),
]

# Demo history: (lot index, days ago, start hour UTC, hours parked)
DEMO_HISTORY = [(0, 20, 4, 2.0), (1, 17, 9, 3.5), (3, 15, 12, 2.0), (2, 13, 6, 1.5), (0, 9, 11, 4.0),
                (4, 7, 7, 3.0), (1, 5, 5, 2.5), (5, 3, 10, 1.5), (2, 2, 8, 1.0)]


def init_db(app):
    db.init_app(app)
    with app.app_context():
        try:
            db.create_all()
            seed_data(app)
        except (IntegrityError, OperationalError):
            # The web server and a worker can start together and create or seed the same tables
            db.session.rollback()


def seed_data(app):
    if not User.query.filter_by(role='admin').first():
        admin = User(username='admin', email='admin@parkitv2.com', role='admin', avatar='avatar3.png')
        admin.set_password(app.config['ADMIN_PASSWORD'])
        db.session.add(admin)
        db.session.commit()
        app.logger.info('Admin user created')

    if ParkingLot.query.count() == 0:
        for name, address, pin, price, spots in SEED_LOTS:
            lot = ParkingLot(prime_location_name=name, address=address, pin_code=pin,
                             price=price, number_of_spots=spots)
            lot.spots = [ParkingSpot(status='A') for _ in range(spots)]
            db.session.add(lot)
        db.session.commit()
        app.logger.info('Sample parking lots created')

    if not User.query.filter_by(username='demo').first():
        demo = User(username='demo', email='demo@parkitv2.com', role='user', avatar='avatar1.png')
        demo.set_password('demo1234')
        db.session.add(demo)
        db.session.flush()

        lots = ParkingLot.query.filter_by(is_deleted=False).order_by(ParkingLot.id).all()
        now = utcnow()
        for lot_index, days_ago, hour, hours in DEMO_HISTORY:
            if lot_index >= len(lots):
                continue
            lot = lots[lot_index]
            start = (now - timedelta(days=days_ago)).replace(hour=hour, minute=0, second=0, microsecond=0)
            db.session.add(Reservation(
                spot_id=min(spot.id for spot in lot.spots),
                user_id=demo.id,
                vehicle_number='DL01AB1234',
                parking_timestamp=start,
                leaving_timestamp=start + timedelta(hours=hours),
                parking_cost=round(billed_hours(start, start + timedelta(hours=hours)) * lot.price, 2),
                price_per_hour=lot.price,
                status='completed'
            ))
        db.session.commit()
        app.logger.info('Demo user created')


init_db(app)
register_routes(app, cache)
