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

    # Parking lots

    @app.route('/api/parking-lots', methods=['GET'])
    @cache.cached(timeout=60, key_prefix='all_parking_lots')
    def get_parking_lots():
        lots = ParkingLot.query.filter_by(is_deleted=False).all()
        available = dict(db.session.query(ParkingSpot.lot_id, db.func.count()).filter(
            ParkingSpot.status == 'A').group_by(ParkingSpot.lot_id).all())
        result = []

        for lot in lots:
            result.append({
                'id': lot.id,
                'prime_location_name': lot.prime_location_name,
                'address': lot.address,
                'pin_code': lot.pin_code,
                'price': lot.price,
                'number_of_spots': lot.number_of_spots,
                'available_spots': available.get(lot.id, 0)
            })

        return jsonify(result), 200

    @app.route('/api/parking-lots', methods=['POST'])
    @admin_required
    def create_parking_lot():
        values, error = read_lot(request.get_json(silent=True))
        if error:
            return jsonify({'message': error}), 400

        lot = ParkingLot(**values)
        lot.spots = [ParkingSpot(status='A') for _ in range(values['number_of_spots'])]
        db.session.add(lot)
        db.session.commit()

        # Lot names and prices appear in most cached responses
        invalidate()

        try:
            tasks.notify_inactive_users_new_lot.delay(lot.id)
        except Exception:
            app.logger.exception('Failed to queue new lot notifications for lot %s', lot.id)

        return jsonify({
            'message': 'Parking lot created successfully. Inactive users will be notified via email.',
            'lot_id': lot.id
        }), 201

    @app.route('/api/parking-lots/<int:lot_id>', methods=['PUT'])
    @admin_required
    def update_parking_lot(lot_id):
        lot = db.session.get(ParkingLot, lot_id)

        if not lot or lot.is_deleted:
            return jsonify({'message': 'Parking lot not found'}), 404

        values, error = read_lot(request.get_json(silent=True), partial=True)
        if error:
            return jsonify({'message': error}), 400

        new_spots = values.pop('number_of_spots', None)
        current_spots = len(lot.spots)
        to_remove = []

        if new_spots is not None and new_spots < current_spots:
            free = ParkingSpot.query.filter_by(lot_id=lot.id, status='A').order_by(ParkingSpot.id.desc()).all()
            if len(free) < current_spots - new_spots:
                occupied = current_spots - len(free)
                return jsonify({'message': f"Cannot reduce to {new_spots} {'spot' if new_spots == 1 else 'spots'}: "
                                           f"{occupied} {'spot is' if occupied == 1 else 'spots are'} occupied"}), 400

            # Remove spots without booking history first so past bookings stay linked
            free.sort(key=lambda spot: bool(spot.reservations))
            to_remove = free[:current_spots - new_spots]
            if any(spot.reservations for spot in to_remove):
                return jsonify({'message': f"Cannot reduce to {new_spots} {'spot' if new_spots == 1 else 'spots'}: some free spots have booking history"}), 400

        for key, value in values.items():
            setattr(lot, key, value)

        if new_spots is not None:
            for spot in to_remove:
                db.session.delete(spot)
            for _ in range(new_spots - current_spots):
                db.session.add(ParkingSpot(lot_id=lot.id, status='A'))
            lot.number_of_spots = new_spots

        try:
            db.session.commit()
        except IntegrityError:
            # A spot chosen for removal was booked in the meantime
            db.session.rollback()
            return jsonify({'message': 'Spots changed while updating. Please try again.'}), 409

        invalidate()

        return jsonify({'message': 'Parking lot updated successfully'}), 200

    @app.route('/api/parking-lots/<int:lot_id>', methods=['DELETE'])
    @admin_required
    def delete_parking_lot(lot_id):
        lot = db.session.get(ParkingLot, lot_id)

        if not lot:
            return jsonify({'message': 'Parking lot not found'}), 404

        if lot.is_deleted:
            return jsonify({'message': 'Parking lot already deleted'}), 409

        # Soft delete keeps past reservations linked to the lot.
        # Checking for occupied spots in the same statement stops a booking from landing in between.
        deleted = ParkingLot.query.filter(
            ParkingLot.id == lot.id, ~ParkingLot.spots.any(ParkingSpot.status == 'O')
        ).update({'is_deleted': True})

        if not deleted:
            db.session.rollback()
            return jsonify({'message': 'Cannot delete parking lot with occupied spots. Please wait for all vehicles to leave.'}), 400

        db.session.commit()

        invalidate()

        return jsonify({'message': 'Parking lot deleted successfully'}), 200

    @app.route('/api/admin/parking-lots-revenue', methods=['GET'])
    @admin_required
    @cache.cached(timeout=120, key_prefix='parking_lots_revenue')
    def get_parking_lots_revenue():
        lots = ParkingLot.query.filter_by(is_deleted=False).all()
        totals = {lot_id: (revenue, count) for lot_id, revenue, count in db.session.query(
            ParkingSpot.lot_id, db.func.sum(Reservation.parking_cost), db.func.count(Reservation.id)
        ).join(Reservation).filter(
            Reservation.status == 'completed',
            Reservation.parking_cost.isnot(None)
        ).group_by(ParkingSpot.lot_id)}
        result = []

        for lot in lots:
            revenue, bookings = totals.get(lot.id, (0, 0))
            result.append({
                'lot_id': lot.id,
                'location_name': lot.prime_location_name,
                'revenue': round(revenue, 2),
                'total_spots': lot.number_of_spots,
                'bookings_count': bookings
            })

        result.sort(key=lambda x: x['revenue'], reverse=True)

        return jsonify(result), 200

    # Reservations

    @app.route('/api/book-spot', methods=['POST'])
    @login_required
    def book_spot():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            data = {}

        if g.user.role != 'user':
            return jsonify({'message': 'Only users can book parking spots'}), 403

        user_id = g.user.id
        lot_id = data.get('lot_id')
        vehicle_number = re.sub(r'[\s-]', '', str(data.get('vehicle_number') or '')).upper()

        if not lot_id or not vehicle_number:
            return jsonify({'message': 'Missing required fields'}), 400
        if not VEHICLE_RE.match(vehicle_number):
            return jsonify({'message': 'Enter a valid vehicle number, e.g. MH12AB1234'}), 400

        lot = db.session.get(ParkingLot, lot_id) if isinstance(lot_id, int) or str(lot_id).isdigit() else None
        if not lot or lot.is_deleted:
            return jsonify({'message': 'Parking lot not found'}), 404

        existing_booking = Reservation.query.filter_by(user_id=user_id, status='active').first()
        if existing_booking:
            return jsonify({'message': 'You already have an active booking. Please release it before booking a new spot.'}), 409

        # Claim a spot only if it is still free and its lot was not deleted meanwhile,
        # so two concurrent bookings cannot get the same spot
        spot = None
        candidates = ParkingSpot.query.filter_by(lot_id=lot.id, status='A').order_by(ParkingSpot.id).limit(5).all()
        for candidate in candidates:
            if ParkingSpot.query.filter(
                ParkingSpot.id == candidate.id, ParkingSpot.status == 'A',
                ParkingSpot.parking_lot.has(is_deleted=False)
            ).update({'status': 'O'}) == 1:
                spot = candidate
                break

        if not spot:
            db.session.rollback()
            return jsonify({'message': 'No available spots in this parking lot'}), 409

        reservation = Reservation(
            spot_id=spot.id,
            user_id=user_id,
            vehicle_number=vehicle_number,
            parking_timestamp=utcnow(),
            price_per_hour=lot.price,
            status='active'
        )
        db.session.add(reservation)
        try:
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            return jsonify({'message': 'You already have an active booking.'}), 409

        invalidate('all_parking_lots', f'parking_spots_{lot.id}', f'user_reservations_{user_id}',
                   f'user_stats_{user_id}', 'admin_dashboard_stats', 'parking_lots_revenue', 'all_users')

        return jsonify({
            'message': 'Spot booked successfully',
            'spot_id': spot.id,
            'reservation_id': reservation.id
        }), 201

    @app.route('/api/release-spot/<int:reservation_id>', methods=['PUT'])
    @login_required
    def release_spot(reservation_id):
        reservation = db.session.get(Reservation, reservation_id)

        if not reservation:
            return jsonify({'message': 'Reservation not found'}), 404

        if reservation.user_id != g.user.id:
            return jsonify({'message': 'Not allowed'}), 403

        if reservation.status != 'active':
            return jsonify({'message': 'This reservation has already been released'}), 409

        lot_id = reservation.spot.lot_id
        leaving = utcnow()
        cost = round(billed_hours(reservation.parking_timestamp, leaving) * booked_price(reservation), 2)

        # Only one of two concurrent releases may complete the booking
        released = Reservation.query.filter_by(id=reservation.id, status='active').update(
            {'status': 'completed', 'leaving_timestamp': leaving, 'parking_cost': cost})
        if released == 0:
            db.session.rollback()
            return jsonify({'message': 'This reservation has already been released'}), 409
        ParkingSpot.query.filter_by(id=reservation.spot_id).update({'status': 'A'})
        db.session.commit()

        user_id = reservation.user_id
        invalidate('all_parking_lots', f'parking_spots_{lot_id}', f'user_reservations_{user_id}',
                   f'user_stats_{user_id}', 'admin_dashboard_stats', 'parking_lots_revenue', 'all_users')

        return jsonify({
            'message': 'Spot released successfully',
            'parking_cost': cost
        }), 200

    @app.route('/api/user-reservations/<int:user_id>', methods=['GET'])
    @login_required
    @self_or_admin
    @cache.cached(timeout=30, key_prefix=lambda: f'user_reservations_{request.view_args["user_id"]}')
    def get_user_reservations(user_id):
        reservations = Reservation.query.filter_by(user_id=user_id).order_by(Reservation.parking_timestamp.desc()).all()
        numbers = spot_numbers({res.spot.lot_id for res in reservations})
        result = []

        for res in reservations:
            duration = None
            if res.leaving_timestamp:
                seconds = (res.leaving_timestamp - res.parking_timestamp).total_seconds()
                duration = f"{int(seconds // 3600)}h {int((seconds % 3600) // 60)}m"

            parking_lot = res.spot.parking_lot

            result.append({
                'id': res.id,
                'spot_id': res.spot_id,
                'spot_number': numbers.get(res.spot_id),
                'lot_name': parking_lot.prime_location_name,
                'address': parking_lot.address,
                'pin_code': parking_lot.pin_code,
                'price_per_hour': booked_price(res),
                'vehicle_number': res.vehicle_number,
                'parking_timestamp': iso(res.parking_timestamp),
                'leaving_timestamp': iso(res.leaving_timestamp),
                'duration': duration,
                'parking_cost': res.parking_cost,
                'status': res.status
            })

        return jsonify(result), 200

    @app.route('/api/user-stats/<int:user_id>', methods=['GET'])
    @login_required
    @self_or_admin
    @cache.cached(timeout=60, key_prefix=lambda: f'user_stats_{request.view_args["user_id"]}')
    def get_user_stats(user_id):
        reservations = Reservation.query.filter_by(user_id=user_id).all()

        total_spent = sum(res.parking_cost for res in reservations if res.parking_cost)

        lot_spending = {}
        for res in reservations:
            if res.parking_cost and res.spot and res.spot.parking_lot:
                lot_name = res.spot.parking_lot.prime_location_name
                lot_spending[lot_name] = lot_spending.get(lot_name, 0) + res.parking_cost

        # Last 6 IST months, oldest first
        now = datetime.now(tasks.IST)
        months = []
        year, month = now.year, now.month
        for _ in range(6):
            months.insert(0, (year, month))
            year, month = (year, month - 1) if month > 1 else (year - 1, 12)
        monthly = {f'{year}-{month:02d}': {'bookings': 0, 'spent': 0.0} for year, month in months}
        for res in reservations:
            bucket = monthly.get(tasks.to_ist(res.parking_timestamp).strftime('%Y-%m'))
            if bucket:
                bucket['bookings'] += 1
                if res.status == 'completed' and res.parking_cost:
                    bucket['spent'] += res.parking_cost

        return jsonify({
            'total_bookings': len(reservations),
            'total_spent': round(total_spent, 2),
            'lot_usage': [
                {'location_name': lot_name, 'total_spent': round(amount, 2)}
                for lot_name, amount in lot_spending.items()
            ],
            'monthly_spend': [
                {
                    'month': f'{year}-{month:02d}',
                    'label': f'{month_abbr[month]} {year}',
                    'total_spent': round(monthly[f'{year}-{month:02d}']['spent'], 2),
                    'bookings': monthly[f'{year}-{month:02d}']['bookings']
                }
                for year, month in months
            ]
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
