"""Owned browser resources and a single monotonic finalization budget."""
import asyncio
import time
from model import require


class Deadline:
    def __init__(self, seconds, clock=time.monotonic):
        self.clock = clock
        self.end = clock() + seconds

    def remaining(self):
        return max(0, self.end - self.clock())

    async def call(self, operation):
        remaining = self.remaining()
        if remaining <= 0:
            raise TimeoutError("FINALIZATION_DEADLINE")
        return await asyncio.wait_for(operation(), remaining)


class Resource:
    def __init__(self, context, stage):
        self.context = context
        self.stage = stage
        self.page = None
        self.closed = False
        self.page_lost = False
        self.close_attempted = False
        self.close_task = None
        context.on("close", lambda *_: self.mark_closed())
        browser = context.browser
        if browser is not None:
            browser.on("disconnected", lambda *_: self.mark_page_lost())

    def mark_closed(self):
        self.closed = True

    def own_page(self, page):
        self.page = page
        page.on("crash", lambda *_: self.mark_page_lost())
        page.on("close", lambda *_: self.mark_page_lost())

    def mark_page_lost(self):
        self.page_lost = True

    def usable(self):
        return not self.closed and not self.page_lost and self.page is not None and not self.page.is_closed()

    async def close(self, deadline):
        if self.close_task is not None:
            return await asyncio.shield(self.close_task)
        if self.closed:
            return
        if self.close_attempted:
            raise RuntimeError("CONTEXT_CLOSE_UNCONFIRMED: " + self.stage)
        self.close_attempted = True
        async def close_once():
            await deadline.call(self.context.close)
            self.closed = True
        self.close_task = asyncio.create_task(close_once())
        return await asyncio.shield(self.close_task)


class Lifecycle:
    def __init__(self, seconds):
        self.seconds = seconds
        self.deadline = None
        self.resources = []
        self.rescuing = False
        self.rescued = False

    def begin(self):
        if self.deadline is None:
            self.deadline = Deadline(self.seconds)
        return self.deadline

    def own(self, context, stage):
        require(all(r.closed for r in self.resources), "PERSISTENT_PROFILE_STILL_OWNED")
        resource = Resource(context, stage)
        self.resources.append(resource)
        return resource

    async def cleanup(self, status):
        for resource in reversed(self.resources):
            try:
                await resource.close(self.begin())
            except Exception as error:
                # Each failed resource has one recorded cleanup error, even after reentry.
                if not getattr(resource, "reported", False):
                    resource.reported = True
                    status.error("close-" + resource.stage, error)
        status.data["resources"] = [dict(stage=r.stage, closed=r.closed, closeAttempted=r.close_attempted) for r in self.resources]
