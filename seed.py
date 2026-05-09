"""
Demo data so ChatWire looks like a real team workspace.

Usage (from project root, venv on):
  python seed.py
"""

from datetime import datetime, timedelta, timezone

import db
import state


PEOPLE = [
    ("demo", "Alex Rivera", "demo123456"),
    ("sam", "Sam Okonkwo", "sam1234567"),
    ("jordan", "Jordan Lee", "jordan1234"),
    ("casey", "Casey Nguyen", "casey12345"),
]


MESSAGES = [
    ("sam", "Sam Okonkwo", "Morning - standup in 10 if anyone needs the link."),
    ("jordan", "Jordan Lee", "I'll be there. Blocker on the auth PR, need a second pair of eyes."),
    ("casey", "Casey Nguyen", "I can look after standup. Also calendar invite for Friday review is up."),
    ("demo", "Alex Rivera", "Sounds good. Drop notes in #projects when you're done."),
    ("sam", "Sam Okonkwo", "Reminder: coursework deadline Thursday 5pm for the group report."),
]


EVENTS = [
    ("dev-hub", "Daily standup", 1, 9, 0, 30, "Meet now / #general"),
    ("dev-hub", "Sprint review", 5, 14, 0, 60, "Dev Hub"),
    ("mmu-year3", "Group report sync", 2, 16, 30, 45, "Teams call"),
]


def ensure_users():
    for username, display, password in PEOPLE:
        if not db.get_user(username):
            db.create_user(username, display, state.hash_password(password))


def seed_friends():
    # demo is friends with everyone; they are friends with each other too
    pairs = [
        ("demo", "sam"),
        ("demo", "jordan"),
        ("demo", "casey"),
        ("sam", "jordan"),
        ("jordan", "casey"),
    ]
    for a, b in pairs:
        db.add_friend(a, b)


def seed_events():
    existing = db.list_events("dev-hub", limit=1)
    if existing:
        return
    now = datetime.now(timezone.utc)
    for community, title, day_offset, hour, minute, duration_min, location in EVENTS:
        start = (now + timedelta(days=day_offset)).replace(
            hour=hour, minute=minute, second=0, microsecond=0
        )
        end = start + timedelta(minutes=duration_min)
        db.create_event(
            community,
            title,
            start.isoformat(),
            "demo",
            ends_at=end.isoformat(),
            location=location,
        )


def seed_messages():
    existing = db.channel_history("dev-hub", "general", limit=5)
    if isinstance(existing, dict):
        existing = existing.get("messages") or []
    if existing:
        print("dev-hub/general already has messages - skipping chat seed.")
        return
    for username, display, text in MESSAGES:
        db.store_message("dev-hub", "general", username, display, text)
    db.store_message(
        "mmu-year3",
        "coursework",
        "casey",
        "Casey Nguyen",
        "Anyone free Tuesday to finish the methodology section?",
    )
    db.store_message(
        "mmu-year3",
        "coursework",
        "demo",
        "Alex Rivera",
        "Yeah, after 3. I'll put it on the calendar.",
    )


def seed_feed():
    existing = db.list_feed("demo", limit=1)
    if existing.get("posts"):
        return
    samples = [
        (
            "demo",
            "Alex Rivera",
            "Wrapped the ChatWire standup flow today. Friends list + calendar finally feel usable.",
            "https://picsum.photos/seed/chatwire1/900/520",
        ),
        (
            "sam",
            "Sam Okonkwo",
            "Coffee + PR reviews. If anyone is free later, jump on Meet now in #general.",
            "",
        ),
        (
            "jordan",
            "Jordan Lee",
            "Group report outline done. Dropping the draft link in coursework tomorrow.",
            "https://picsum.photos/seed/chatwire2/900/520",
        ),
        (
            "casey",
            "Casey Nguyen",
            "Friday sprint review is on the calendar. Bring blockers.",
            "",
        ),
    ]
    for username, display, text, image in samples:
        db.create_post(username, display, text, image)
    # a couple likes/comments so the feed looks alive
    posts = db.list_feed("demo", limit=10)["posts"]
    if posts:
        db.toggle_post_like(posts[0]["id"], "sam")
        db.toggle_post_like(posts[0]["id"], "jordan")
        db.add_post_comment(posts[0]["id"], "casey", "Casey Nguyen", "Looks solid - nice work.")
        if len(posts) > 1:
            db.toggle_post_like(posts[1]["id"], "demo")


def seed_stories():
    # skip if anyone already posted a story
    if db.list_story_groups("demo"):
        return
    db.create_story(
        "demo",
        "Alex Rivera",
        "Ship day energy",
        "https://picsum.photos/seed/cwstory1/720/1280",
    )
    db.create_story(
        "sam",
        "Sam Okonkwo",
        "Lab until 5 - ping me after",
        "",
        "#0f766e",
    )
    db.create_story(
        "jordan",
        "Jordan Lee",
        "Draft v2 ready for eyes",
        "https://picsum.photos/seed/cwstory2/720/1280",
    )
    db.set_user_status("demo", "available", "Open to quick calls")
    db.set_user_status("sam", "busy", "In a lecture")
    db.set_user_status("jordan", "away", "Back after 4")


def main():
    db.init_db()
    ensure_users()
    seed_friends()
    seed_events()
    seed_messages()
    seed_feed()
    seed_stories()
    print("Seeded users, friends, calendar, chat, feed, status and stories.")
    print("Login: demo / demo123456  (also sam/jordan/casey with longer passwords in seed.py)")


if __name__ == "__main__":
    main()
