"""Wire up all the socket handler modules."""

from sockets import (
    channel_handlers,
    message_handlers,
    session_handlers,
    social_handlers,
    status_handlers,
    timeline_handlers,
)


def register_handlers(socketio):
    session_handlers.register(socketio)
    channel_handlers.register(socketio)
    message_handlers.register(socketio)
    social_handlers.register(socketio)
    timeline_handlers.register(socketio)
    status_handlers.register(socketio)
