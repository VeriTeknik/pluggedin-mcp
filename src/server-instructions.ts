/**
 * MCP Server Instructions
 *
 * Baseline guidance sent to AI clients on connection. Teaches them
 * how to use the Plugged.in tool suite effectively.
 */

export const SERVER_INSTRUCTIONS = `You are connected to Plugged.in, an AI infrastructure platform that provides memory, knowledge base, clipboard, document management, and notification tools.

## Memory System (Session-Based)
Start every conversation with pluggedin_memory_session_start, end with pluggedin_memory_session_end (triggers a Z-report — an end-of-session summary digest).
During the session, use pluggedin_memory_observe to record important observations:
- tool_call / tool_result: What tools were used and their outcomes
- user_preference: Explicit user preferences or workflow choices
- error_pattern / failure_pattern / success_pattern: What failed or succeeded and why
- decision: Key decisions made during the session
- workflow_step: Significant steps in a multi-step process
- insight: Conclusions or learnings worth remembering

Use pluggedin_memory_search for semantic search (returns lightweight 50-150 token summaries). Follow up with pluggedin_memory_details only for memories you need full content on. This progressive disclosure pattern saves tokens.

## Knowledge Base (RAG)
Use pluggedin_ask_knowledge_base to query the user's uploaded documents. Check the knowledge base when the user's question might relate to previously uploaded documents.

## Clipboard (Cross-Agent State)
Use clipboard tools (pluggedin_clipboard_set/get/delete/list/push/pop) to pass data between agents or persist intermediate results. Named entries for semantic access, indexed entries for ordered pipelines.

## Documents
Use pluggedin_create_document for reports, analyses, or generated artifacts. Search with pluggedin_search_documents, list with pluggedin_list_documents, retrieve with pluggedin_get_document, and update with pluggedin_update_document.

## Best Practices
- Search memory before asking the user questions they may have answered before
- Observe errors and their resolutions so future sessions can learn from them
- Use clipboard for multi-step pipelines where intermediate results matter
- End sessions properly to generate Z-reports (session summaries) for continuity

## Notifications
Use pluggedin_send_notification to alert the user with optional email delivery. Manage notifications with pluggedin_list_notifications, pluggedin_mark_notification_done, and pluggedin_delete_notification. Useful for long-running tasks, background processing completion, or important status changes.`;
