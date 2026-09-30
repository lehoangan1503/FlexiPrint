"""FlexiPrint node pack for ComfyUI — clipart library studio.

Nodes (nodes.py) build cliparts, variant sets, material renditions and mockups
from the FlexiPrint library context and save them back. js/flexiprint.js adds
the FlexiPrint sidebar (library browser) and the "Ngữ cảnh" bottom panel.
Workflow templates live in example_workflows/.
"""

from comfy_api.latest import ComfyExtension, io

from . import routes  # noqa: F401 — registers /flexi/* routes
from .nodes import NODES

WEB_DIRECTORY = "./js"


class FlexiPrintExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return NODES


async def comfy_entrypoint() -> FlexiPrintExtension:
    return FlexiPrintExtension()


__all__ = ["WEB_DIRECTORY", "comfy_entrypoint"]
