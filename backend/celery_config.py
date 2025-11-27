from celery import Celery
from celery.schedules import crontab
from celery.signals import worker_process_init
from backend.models.models import db
import ssl


def make_celery(app):
    redis_url = app.config['REDIS_URL']
    celery = Celery('parkit_v2', broker=redis_url, backend=redis_url)
    celery.conf.update(
        timezone='Asia/Kolkata',
        enable_utc=True,
        task_track_started=True,
        broker_connection_retry_on_startup=True,
        # A worker started without -Q consumes this queue too
        task_default_queue='parkit_v2',
        beat_schedule={
            'daily-reminder': {
                'task': 'send_daily_reminder',
                'schedule': crontab(hour=18, minute=0),
            },
            'monthly-report': {
                'task': 'send_all_monthly_reports',
                'schedule': crontab(day_of_month=1, hour=9, minute=0),
            },
        },
    )
    if redis_url.startswith('rediss://'):
        tls = {'ssl_cert_reqs': ssl.CERT_REQUIRED}
        celery.conf.update(broker_use_ssl=tls, redis_backend_use_ssl=tls)
    if app.config['VERCEL']:
        # No worker on Vercel: run tasks in-process and keep results in Redis
        celery.conf.update(task_always_eager=True, task_store_eager_result=True)

    @worker_process_init.connect(weak=False)
    def reset_db_pool(**kwargs):
        # Forked worker processes must not reuse SQLite connections opened by the parent
        with app.app_context():
            db.engine.dispose(close=False)

    class ContextTask(celery.Task):
        def __call__(self, *args, **kwargs):
            with app.app_context():
                return self.run(*args, **kwargs)

    celery.Task = ContextTask
    return celery
