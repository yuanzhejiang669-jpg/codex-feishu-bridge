from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP

from tavily_router_core import TavilyRouter

mcp = FastMCP('tavily')
router = TavilyRouter()


@mcp.tool()
def tavily_search(
    query: str,
    search_depth: str = 'advanced',
    max_results: int = 5,
    include_answer: bool = True,
    include_raw_content: bool = False,
    include_images: bool = False,
) -> dict[str, Any]:
    result = router.search(
        query=query,
        search_depth='advanced',
        max_results=max_results,
        include_answer=include_answer,
        include_raw_content=include_raw_content,
        include_images=include_images,
    )
    return {
        'results': result['results'],
        'used_key_alias': result['used_key_alias'],
        'attempts': result['attempts'],
    }


if __name__ == '__main__':
    mcp.run()
