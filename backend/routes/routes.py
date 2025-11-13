from flask import request, jsonify, send_file, session, redirect, send_from_directory, g
from werkzeug.exceptions import HTTPException
from sqlalchemy.exc import IntegrityError
from celery.result import AsyncResult
from backend.models.models import db, User, ParkingLot, ParkingSpot, Reservation, utcnow, spot_numbers, billed_hours
from backend import tasks
from calendar import month_abbr
from datetime import datetime, timedelta, timezone
from functools import wraps
from urllib.parse import urlsplit
import hmac
import io
import math
import os
import re

EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
USERNAME_RE = re.compile(r'^[A-Za-z0-9_.-]{3,30}$')
VEHICLE_RE = re.compile(r'^[A-Z0-9]{4,12}$')
AVATARS = {f'avatar{i}.png' for i in range(1, 5)}


def load_session_user():
    """Return the logged-in user, or None. Clears the session if the account was deleted or its id reused."""
    if 'user_id' not in session:
        return None
    user = db.session.get(User, session['user_id'])
    if not user or user.username != session.get('username'):
        session.clear()
        return None
    return user


def deny(status, message):
    if request.path.startswith('/api/'):
        return jsonify({'message': message}), status
    return redirect('/')


def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        g.user = load_session_user()
        if not g.user:
            return deny(401, 'Authentication required')
        return f(*args, **kwargs)
    return decorated_function


def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        g.user = load_session_user()
        if not g.user:
            return deny(401, 'Authentication required')
        if g.user.role != 'admin':
            return deny(403, 'Admin access required')
        return f(*args, **kwargs)
    return decorated_function


def self_or_admin(f):
    """Must sit above @cache.cached so a cache hit never skips the ownership check."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if g.user.id != kwargs['user_id'] and g.user.role != 'admin':
            return jsonify({'message': 'Not allowed'}), 403
        return f(*args, **kwargs)
    return decorated_function


def iso(dt):
    """Stored timestamps are naive UTC; mark them as UTC for the client."""
    return dt.isoformat(timespec='seconds') + 'Z' if dt else None


def ist_day_start(day):
    """Midnight IST of the given date as naive UTC, comparable with stored timestamps."""
    return datetime(day.year, day.month, day.day, tzinfo=tasks.IST).astimezone(timezone.utc).replace(tzinfo=None)


def validate_account(username, email, password):
    """Return an error message or None. Fields passed as None are not checked."""
    if username is not None and not USERNAME_RE.match(username):
        return 'Username must be 3 to 30 characters: letters, numbers, dots, dashes or underscores'
    if email is not None and (len(email) > 120 or not EMAIL_RE.match(email)):
        return 'Please enter a valid email address'
    if password is not None and len(password) < 6:
        return 'Password must be at least 6 characters'
    return None


def booked_price(res):
    """Hourly price saved at booking, or the lot's current price for rows without it."""
    return res.price_per_hour if res.price_per_hour is not None else res.spot.parking_lot.price


def read_lot(data, partial=False):
    """Validate lot fields. Returns (values, error). With partial=True only given fields are checked."""
    if not isinstance(data, dict):
        return None, 'Invalid request body'

    def wanted(key):
        return not partial or key in data

    values = {}
    for key, label in (('prime_location_name', 'Location name'), ('address', 'Address')):
        if wanted(key):
            value = str(data.get(key) or '').strip()
            if not value:
                return None, f'{label} is required'
            values[key] = value

    if wanted('pin_code'):
        pin = str(data.get('pin_code') or '').strip()
        if not (len(pin) == 6 and pin.isdigit()):
            return None, 'Pin code must be 6 digits'
        values['pin_code'] = pin

    if wanted('price'):
        try:
            price = float(data.get('price'))
        except (TypeError, ValueError):
            price = 0
        if not (math.isfinite(price) and price > 0):
            return None, 'Price must be a number greater than 0'
        values['price'] = price

    if wanted('number_of_spots'):
        try:
            spots = int(str(data.get('number_of_spots')).strip())
        except ValueError:
            spots = 0
        if not 1 <= spots <= 500:
            return None, 'Number of spots must be a whole number from 1 to 500'
        values['number_of_spots'] = spots

    return values, None


def register_routes(app, cache):

    frontend_dir = os.path.join(os.path.dirname(app.root_path), 'frontend')
    index_file_path = os.path.join(frontend_dir, 'index.html')

    def invalidate(*keys):
        """Drop cached responses after a commit; with no keys, drop all of them.
        A cache error only leaves entries until they expire, so it is logged instead of raised."""
        try:
            if keys:
                cache.delete_many(*keys)
            else:
                cache.clear()
        except Exception:
            app.logger.exception('Cache invalidation failed')

    @app.before_request
    def reject_cross_site_writes():
        # Cross-site pages cannot send a JSON body without a CORS preflight, which this app never allows.
        # Bodyless writes must come from this host.
        if request.method in ('GET', 'HEAD', 'OPTIONS') or not request.path.startswith('/api/'):
            return None
        if request.is_json:
            return None
        source = request.headers.get('Origin') or request.headers.get('Referer')
        if source and urlsplit(source).netloc == request.host:
            return None
        return jsonify({'message': 'Cross-site request blocked'}), 403

    @app.errorhandler(HTTPException)
    def handle_http_error(e):
        if request.path.startswith('/api/'):
            return jsonify({'message': e.description}), e.code
        return e

    @app.errorhandler(500)
    def handle_server_error(e):
        return jsonify({'message': 'Internal server error'}), 500

    @app.route('/')
    def index():
        return send_file(index_file_path)

    @app.route('/user_dashboard')
    @login_required
    def user_dashboard():
        return send_file(index_file_path)

    @app.route('/admin_dashboard')
    @admin_required
    def admin_dashboard():
        return send_file(index_file_path)

    @app.route('/images/<path:filename>')
    def serve_image(filename):
        return send_from_directory(os.path.join(frontend_dir, 'images'), filename)

    # Auth

    @app.route('/api/register', methods=['POST'])
    def register():
        data = request.get_json(silent=True)

        if not isinstance(data, dict) or not all(data.get(k) for k in ['username', 'email', 'password']):
            return jsonify({'message': 'Missing required fields'}), 400

        username = str(data['username']).strip()
        email = str(data['email']).strip().lower()
        password = str(data['password'])

        error = validate_account(username, email, password)
        if error:
            return jsonify({'message': error}), 400

        if User.query.filter_by(username=username).first():
            return jsonify({'message': 'Username already exists'}), 409

        if User.query.filter_by(email=email).first():
            return jsonify({'message': 'Email already exists'}), 409

        user = User(username=username, email=email, role='user')
        user.set_password(password)
        db.session.add(user)
        try:
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            return jsonify({'message': 'Username or email already exists'}), 409

        invalidate('all_users', 'admin_dashboard_stats')

        return jsonify({'message': 'Account created successfully. Please sign in.'}), 201

    @app.route('/api/login', methods=['POST'])
    def login():
        data = request.get_json(silent=True)
        identifier = data.get('username') if isinstance(data, dict) else None
        password = data.get('password') if isinstance(data, dict) else None

        if not isinstance(identifier, str) or not isinstance(password, str) or not identifier.strip() or not password:
            return jsonify({'message': 'Missing username or password'}), 400

        # The identifier can be a username or an email
        identifier = identifier.strip()
        user = User.query.filter((User.username == identifier) | (User.email == identifier.lower())).first()

        if not user or not user.check_password(password):
            return jsonify({'message': 'Invalid username or password'}), 401

        # New session id on login, so an id set before login cannot be reused
        session.clear()
        session['user_id'] = user.id
        session['username'] = user.username
        app.session_interface.regenerate(session)

        return jsonify({
            'message': 'Login successful',
            'role': user.role,
            'avatar': user.avatar
        }), 200

    @app.route('/api/logout', methods=['POST'])
    def logout():
        session.clear()
        return jsonify({'message': 'Logged out successfully'}), 200

    @app.route('/api/current-user', methods=['GET'])
    def get_current_user():
        user = load_session_user()
        if not user:
            return jsonify({'message': 'Not authenticated'}), 401

        return jsonify({
            'id': user.id,
            'username': user.username,
            'email': user.email,
            'role': user.role,
            'avatar': user.avatar
        }), 200

    # Profile

    @app.route('/api/user/profile/<int:user_id>', methods=['PUT'])
    @login_required
    def update_profile(user_id):
        if g.user.id != user_id:
            return jsonify({'message': 'Not allowed'}), 403

        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            data = {}
        user = g.user

        username = str(data['username']).strip() if data.get('username') else None
        email = str(data['email']).strip().lower() if data.get('email') else None
        new_password = str(data['newPassword']) if data.get('newPassword') else None
        avatar = str(data['avatar']).strip() if data.get('avatar') else None

        error = validate_account(username, email, new_password)
        if error:
            return jsonify({'message': error}), 400
        if avatar and avatar not in AVATARS:
            return jsonify({'message': 'Please choose one of the available avatars'}), 400

        if username and User.query.filter(User.username == username, User.id != user.id).first():
            return jsonify({'message': 'Username already taken'}), 409
        if email and User.query.filter(User.email == email, User.id != user.id).first():
            return jsonify({'message': 'Email already taken'}), 409

        if new_password:
            if not data.get('currentPassword'):
                return jsonify({'message': 'Current password is required'}), 400
            if not user.check_password(str(data['currentPassword'])):
                return jsonify({'message': 'Current password is incorrect'}), 403
            user.set_password(new_password)

        username_changed = bool(username) and username != user.username
        if username:
            user.username = username
        if email:
            user.email = email
        if avatar:
            user.avatar = avatar

        try:
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            return jsonify({'message': 'Username or email already taken'}), 409

        session['username'] = user.username

        keys = ['all_users']
        if username_changed:
            # The admin spot grid shows the username of an active booking
            active = Reservation.query.filter_by(user_id=user.id, status='active').first()
            if active:
                keys.append(f'parking_spots_{active.spot.lot_id}')
        invalidate(*keys)

        return jsonify({
            'message': 'Profile updated successfully',
            'user': {
                'id': user.id,
                'username': user.username,
                'email': user.email,
                'avatar': user.avatar
            }
        }), 200
