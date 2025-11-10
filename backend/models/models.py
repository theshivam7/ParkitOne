from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import event
from sqlalchemy.engine import Engine
from datetime import datetime, timezone
from werkzeug.security import generate_password_hash, check_password_hash
import math
import sqlite3

db = SQLAlchemy()


@event.listens_for(Engine, 'connect')
def enable_sqlite_foreign_keys(dbapi_connection, connection_record):
    # SQLite ignores foreign keys unless enabled on each connection
    if isinstance(dbapi_connection, sqlite3.Connection):
        cursor = dbapi_connection.cursor()
        cursor.execute('PRAGMA foreign_keys=ON')
        cursor.close()


def utcnow():
    # Naive UTC, matching how timestamps are stored in SQLite
    return datetime.now(timezone.utc).replace(tzinfo=None)


class User(db.Model):
    __tablename__ = 'user'
    # Never reuse the id of a deleted user, so an old session cannot match a new account
    __table_args__ = {'sqlite_autoincrement': True}

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), nullable=False, default='user')
    avatar = db.Column(db.String(50), nullable=False, default='avatar1.png')
    created_at = db.Column(db.DateTime, default=utcnow)
    
    reservations = db.relationship('Reservation', backref='user', lazy=True, cascade='all, delete-orphan')
    
    def set_password(self, password):
        self.password_hash = generate_password_hash(password)
    
    def check_password(self, password):
        return check_password_hash(self.password_hash, password)


class ParkingLot(db.Model):
    __tablename__ = 'parking_lot'
    
    id = db.Column(db.Integer, primary_key=True)
    prime_location_name = db.Column(db.String(150), nullable=False)
    address = db.Column(db.String(255), nullable=False)
    pin_code = db.Column(db.String(10), nullable=False)
    price = db.Column(db.Float, nullable=False)
    number_of_spots = db.Column(db.Integer, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow)
    is_deleted = db.Column(db.Boolean, default=False)
    
    spots = db.relationship('ParkingSpot', backref='parking_lot', lazy=True, cascade='all, delete-orphan')


class ParkingSpot(db.Model):
    __tablename__ = 'parking_spot'
    
    id = db.Column(db.Integer, primary_key=True)
    lot_id = db.Column(db.Integer, db.ForeignKey('parking_lot.id'), nullable=False)
    status = db.Column(db.String(1), nullable=False, default='A')
    
    reservations = db.relationship('Reservation', backref='spot', lazy=True)

class Reservation(db.Model):
    __tablename__ = 'reservation'
    
    id = db.Column(db.Integer, primary_key=True)
    spot_id = db.Column(db.Integer, db.ForeignKey('parking_spot.id'), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    vehicle_number = db.Column(db.String(20), nullable=False)
    parking_timestamp = db.Column(db.DateTime, default=utcnow)
    leaving_timestamp = db.Column(db.DateTime)
    parking_cost = db.Column(db.Float)
    # Lot price at booking time, so later price edits do not change this booking
    price_per_hour = db.Column(db.Float)
    status = db.Column(db.String(20), nullable=False, default='active')

    # At most one active booking per user and per spot, enforced by the database
    __table_args__ = (
        db.Index('uq_active_booking_user', 'user_id', unique=True, sqlite_where=db.text("status = 'active'")),
        db.Index('uq_active_booking_spot', 'spot_id', unique=True, sqlite_where=db.text("status = 'active'")),
    )


def spot_numbers(lot_ids):
    """Map spot id to its 1-based position within its lot, as shown in the admin spot grid."""
    numbers, counts = {}, {}
    rows = db.session.query(ParkingSpot.id, ParkingSpot.lot_id).filter(
        ParkingSpot.lot_id.in_(lot_ids)).order_by(ParkingSpot.id)
    for spot_id, lot_id in rows:
        counts[lot_id] = counts.get(lot_id, 0) + 1
        numbers[spot_id] = counts[lot_id]
    return numbers


def billed_hours(start, end):
    """Parking is billed per started hour, with a minimum of one hour."""
    return max(1, math.ceil((end - start).total_seconds() / 3600))
