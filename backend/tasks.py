from backend.celery_config import make_celery
from flask import current_app
from flask_mail import Message
from markupsafe import escape
from backend.models.models import db, User, Reservation, ParkingLot, ParkingSpot, utcnow, spot_numbers
import csv
import io
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from calendar import month_name

IST = ZoneInfo('Asia/Kolkata')

celery_app = None

# Bound to real tasks by register_tasks()
export_user_history_csv = None
send_daily_reminder = None
send_all_monthly_reports = None
notify_inactive_users_new_lot = None


def init_celery(app):
    global celery_app
    celery_app = make_celery(app)
    register_tasks()
    return celery_app


def to_ist(dt):
    """Stored timestamps are naive UTC; convert for display."""
    return dt.replace(tzinfo=timezone.utc).astimezone(IST)


def format_ist(dt):
    return to_ist(dt).strftime('%Y-%m-%d %H:%M IST')


def build_history_csv(user):
    reservations = Reservation.query.filter_by(user_id=user.id).order_by(Reservation.parking_timestamp.desc()).all()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        'S.No', 'Location Name', 'Address', 'Pin Code', 'Spot', 'Vehicle Number',
        'Parked At', 'Released At', 'Duration', 'Price per Hour (₹)', 'Total Cost (₹)', 'Status'
    ])

    numbers = spot_numbers({res.spot.lot_id for res in reservations})
    for idx, res in enumerate(reservations, 1):
        duration = 'Ongoing'
        if res.leaving_timestamp:
            seconds = (res.leaving_timestamp - res.parking_timestamp).total_seconds()
            duration = f"{int(seconds // 3600)}h {int((seconds % 3600) // 60)}m"

        lot = res.spot.parking_lot
        writer.writerow([
            idx, lot.prime_location_name, lot.address, lot.pin_code, numbers.get(res.spot_id), res.vehicle_number,
            format_ist(res.parking_timestamp),
            format_ist(res.leaving_timestamp) if res.leaving_timestamp else 'Active',
            duration, f"{res.price_per_hour if res.price_per_hour is not None else lot.price:.2f}",
            f"{res.parking_cost:.2f}" if res.parking_cost is not None else 'N/A',
            res.status
        ])

    return output.getvalue()


def send_email(subject, recipient, html, attachment=None):
    """Returns False when mail is not configured or the recipient domain is not allowed."""
    if not current_app.config.get('MAIL_USERNAME'):
        current_app.logger.info('Mail not configured, skipping email to %s: %s', recipient, subject)
        return False
    allowed = current_app.config.get('MAIL_ALLOWED_DOMAINS')
    if allowed and recipient.rsplit('@', 1)[-1].lower() not in allowed:
        current_app.logger.info('Recipient domain not allowed, skipping email to %s: %s', recipient, subject)
        return False
    try:
        msg = Message(subject=subject, recipients=[recipient], html=html)
        if attachment:
            msg.attach(*attachment)
        current_app.extensions['mail'].send(msg)
        current_app.logger.info('Email sent to %s: %s', recipient, subject)
        return True
    except Exception:
        current_app.logger.exception('Failed to send email to %s', recipient)
        return False


def register_tasks():
    global export_user_history_csv, send_daily_reminder
    global send_all_monthly_reports, notify_inactive_users_new_lot

    @celery_app.task(name='export_user_history_csv')
    def _export_user_history_csv(user_id):
        try:
            user = db.session.get(User, user_id)
            if not user:
                return {'status': 'error', 'user_id': user_id, 'message': 'User not found'}

            csv_data = build_history_csv(user)
            filename = f"parking_history_{user.username}_{datetime.now(IST).strftime('%Y%m%d_%H%M%S')}.csv"
            send_export_email(user.email, user.username, filename, csv_data)

            return {'status': 'success', 'user_id': user_id, 'filename': filename, 'csv_data': csv_data}
        except Exception as e:
            current_app.logger.exception('CSV export failed for user %s', user_id)
            return {'status': 'error', 'user_id': user_id, 'message': str(e)}

    @celery_app.task(name='send_daily_reminder')
    def _send_daily_reminder():
        """Remind users with no active booking and no booking in the last 7 days."""
        try:
            week_ago = utcnow() - timedelta(days=7)
            sent = 0
            for user in User.query.filter_by(role='user').all():
                active = Reservation.query.filter_by(user_id=user.id, status='active').count()
                recent = Reservation.query.filter(
                    Reservation.user_id == user.id,
                    Reservation.parking_timestamp >= week_ago
                ).count()
                if active == 0 and recent == 0 and send_reminder_email(user.email, user.username):
                    sent += 1
            return {'status': 'success', 'message': f'Daily reminders sent to {sent} users'}
        except Exception as e:
            current_app.logger.exception('Daily reminder failed')
            return {'status': 'error', 'message': str(e)}

    @celery_app.task(name='generate_monthly_report')
    def _generate_monthly_report(user_id):
        try:
            user = db.session.get(User, user_id)
            if not user:
                return {'status': 'error', 'message': 'User not found'}

            # Previous calendar month in IST, converted to naive UTC for the query
            this_month = datetime.now(IST).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
            last_month = (this_month - timedelta(days=1)).replace(day=1)
            start = last_month.astimezone(timezone.utc).replace(tzinfo=None)
            end = this_month.astimezone(timezone.utc).replace(tzinfo=None)

            reservations = Reservation.query.filter(
                Reservation.user_id == user_id,
                Reservation.parking_timestamp >= start,
                Reservation.parking_timestamp < end
            ).all()

            total_bookings = len(reservations)
            total_spent = sum(res.parking_cost for res in reservations if res.parking_cost)

            lot_usage = {}
            for res in reservations:
                name = res.spot.parking_lot.prime_location_name
                lot_usage[name] = lot_usage.get(name, 0) + 1
            most_used_lot = max(lot_usage, key=lot_usage.get) if lot_usage else 'N/A'

            send_monthly_report_email(user.email, user.username, total_bookings, total_spent,
                                      most_used_lot, last_month.month, last_month.year)

            return {
                'status': 'success',
                'total_bookings': total_bookings,
                'total_spent': round(total_spent, 2),
                'most_used_lot': most_used_lot
            }
        except Exception as e:
            current_app.logger.exception('Monthly report failed for user %s', user_id)
            return {'status': 'error', 'message': str(e)}

    @celery_app.task(name='send_all_monthly_reports')
    def _send_all_monthly_reports():
        users = User.query.filter_by(role='user').all()
        sent = sum(1 for user in users if _generate_monthly_report(user.id)['status'] == 'success')
        return {'status': 'success', 'message': f'Monthly reports generated for {sent} users'}

    @celery_app.task(name='notify_inactive_users_new_lot')
    def _notify_inactive_users_new_lot(lot_id):
        """Tell users without an active booking about a new lot."""
        try:
            lot = db.session.get(ParkingLot, lot_id)
            if not lot:
                return {'status': 'error', 'message': 'Parking lot not found'}

            notified = 0
            for user in User.query.filter_by(role='user').all():
                active = Reservation.query.filter_by(user_id=user.id, status='active').first()
                if not active and send_new_lot_email(user.email, user.username, lot):
                    notified += 1
            return {'status': 'success', 'message': f'Notified {notified} users about the new parking lot'}
        except Exception as e:
            current_app.logger.exception('New lot notification failed for lot %s', lot_id)
            return {'status': 'error', 'message': str(e)}

    export_user_history_csv = _export_user_history_csv
    send_daily_reminder = _send_daily_reminder
    send_all_monthly_reports = _send_all_monthly_reports
    notify_inactive_users_new_lot = _notify_inactive_users_new_lot


def send_export_email(user_email, username, filename, csv_data):
    html = f"""
    <html>
    <body style="font-family: Arial, sans-serif; padding: 20px;">
        <h2 style="color: #0d6efd;">Parking History Export Ready</h2>
        <p>Hi {escape(username)},</p>
        <p>Your parking history CSV file is attached. Times are shown in IST.</p>
        <p style="color: #666; font-size: 12px;">This is an automated message from Parkit V2.</p>
    </body>
    </html>
    """
    return send_email('Your Parking History Export is Ready', user_email, html,
                      attachment=(filename, 'text/csv', csv_data))


def send_reminder_email(user_email, username):
    lots_html = ""
    for lot in ParkingLot.query.filter_by(is_deleted=False).all():
        available = ParkingSpot.query.filter_by(lot_id=lot.id, status='A').count()
        lots_html += f"""
        <div style="background: #f8f9fa; padding: 10px; margin: 10px 0; border-radius: 5px;">
            <strong>{escape(lot.prime_location_name)}</strong><br>
            Available Spots: {available}/{lot.number_of_spots}<br>
            Price: ₹{lot.price}/hour
        </div>
        """

    html = f"""
    <html>
    <body style="font-family: Arial, sans-serif; padding: 20px;">
        <h2 style="color: #0d6efd;">Hello {escape(username)},</h2>
        <p>We noticed you haven't booked a parking spot recently.</p>
        <p>Check out our available parking locations:</p>
        {lots_html}
        <p style="margin-top: 20px;">
            <a href="{current_app.config['APP_URL']}/user_dashboard"
               style="background: #0d6efd; color: white; padding: 10px 20px;
                      text-decoration: none; border-radius: 5px;">
                Book Now
            </a>
        </p>
        <hr style="margin: 20px 0;">
        <p style="color: #666; font-size: 12px;">This is an automated reminder from Parkit V2.</p>
    </body>
    </html>
    """
    return send_email("Don't Forget to Book Your Parking Spot", user_email, html)


def send_monthly_report_email(user_email, username, total_bookings, total_spent, most_used_lot, month, year):
    month_str = f"{month_name[month]} {year}"
    html = f"""
    <html>
    <body style="font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5;">
        <div style="max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px;">
            <h2 style="color: #0d6efd; border-bottom: 2px solid #0d6efd; padding-bottom: 10px;">
                Monthly Parking Report - {month_str}
            </h2>

            <p>Hi <strong>{escape(username)}</strong>,</p>
            <p>Here's your parking activity summary for last month:</p>

            <div style="background: #f8f9fa; padding: 20px; margin: 20px 0; border-radius: 5px;">
                <table style="width: 100%; border-collapse: collapse;">
                    <tr>
                        <td style="padding: 10px; border-bottom: 1px solid #dee2e6;">
                            <strong>Total Bookings:</strong>
                        </td>
                        <td style="padding: 10px; border-bottom: 1px solid #dee2e6; text-align: right;">
                            <strong style="color: #0d6efd; font-size: 18px;">{total_bookings}</strong>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 10px; border-bottom: 1px solid #dee2e6;">
                            <strong>Total Amount Spent:</strong>
                        </td>
                        <td style="padding: 10px; border-bottom: 1px solid #dee2e6; text-align: right;">
                            <strong style="color: #28a745; font-size: 18px;">₹{total_spent:.2f}</strong>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 10px;">
                            <strong>Most Used Location:</strong>
                        </td>
                        <td style="padding: 10px; text-align: right;">
                            <strong style="color: #6c757d; font-size: 16px;">{escape(most_used_lot)}</strong>
                        </td>
                    </tr>
                </table>
            </div>

            <div style="background: #e7f3ff; padding: 15px; margin: 20px 0; border-left: 4px solid #0d6efd; border-radius: 5px;">
                <p style="margin: 0;"><strong>Tip:</strong> Keep track of your parking expenses for better budgeting.</p>
            </div>

            <p style="text-align: center; margin-top: 30px;">
                <a href="{current_app.config['APP_URL']}/user_dashboard"
                   style="background: #0d6efd; color: white; padding: 12px 30px;
                          text-decoration: none; border-radius: 5px; display: inline-block;">
                    View Dashboard
                </a>
            </p>

            <hr style="margin: 30px 0; border: none; border-top: 1px solid #dee2e6;">
            <p style="color: #666; font-size: 12px; text-align: center;">
                This is an automated monthly report from Parkit V2.<br>
                You're receiving this because you're a registered user.
            </p>
        </div>
    </body>
    </html>
    """
    return send_email(f'Your Monthly Parking Report - {month_str}', user_email, html)


def send_new_lot_email(user_email, username, lot):
    available_spots = ParkingSpot.query.filter_by(lot_id=lot.id, status='A').count()
    html = f"""
    <html>
    <body style="font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5;">
        <div style="max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px;">
            <h2 style="color: #28a745; border-bottom: 2px solid #28a745; padding-bottom: 10px;">
                New Parking Lot Now Available
            </h2>

            <p>Hi <strong>{escape(username)}</strong>,</p>
            <p>We've just added a new parking location that might interest you:</p>

            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        padding: 25px; margin: 20px 0; border-radius: 10px; color: white;">
                <h3 style="margin: 0 0 15px 0; color: white;">{escape(lot.prime_location_name)}</h3>

                <table style="width: 100%; color: white;">
                    <tr>
                        <td style="padding: 8px 0;"><strong>Address:</strong></td>
                        <td style="padding: 8px 0; text-align: right;">{escape(lot.address)}</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 0;"><strong>Pin Code:</strong></td>
                        <td style="padding: 8px 0; text-align: right;">{lot.pin_code}</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 0;"><strong>Price:</strong></td>
                        <td style="padding: 8px 0; text-align: right;">
                            <span style="font-size: 20px; font-weight: bold;">₹{lot.price}/hour</span>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 0;"><strong>Available Spots:</strong></td>
                        <td style="padding: 8px 0; text-align: right;">
                            <span style="font-size: 20px; font-weight: bold;">{available_spots}/{lot.number_of_spots}</span>
                        </td>
                    </tr>
                </table>
            </div>

            <div style="background: #fff3cd; padding: 15px; margin: 20px 0; border-left: 4px solid #ffc107; border-radius: 5px;">
                <p style="margin: 0; color: #856404;">
                    <strong>Book now</strong> to secure your spot at this new location.
                </p>
            </div>

            <p style="text-align: center; margin-top: 30px;">
                <a href="{current_app.config['APP_URL']}/user_dashboard"
                   style="background: #28a745; color: white; padding: 15px 40px;
                          text-decoration: none; border-radius: 5px; display: inline-block;
                          font-size: 16px; font-weight: bold;">
                    Book This Location Now
                </a>
            </p>

            <hr style="margin: 30px 0; border: none; border-top: 1px solid #dee2e6;">
            <p style="color: #666; font-size: 12px; text-align: center;">
                This is an automated notification from Parkit V2.<br>
                You're receiving this because you don't have an active booking.
            </p>
        </div>
    </body>
    </html>
    """
    return send_email(f'New Parking Lot Available - {lot.prime_location_name}', user_email, html)
