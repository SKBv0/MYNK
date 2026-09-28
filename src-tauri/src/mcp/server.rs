//! The MCP server over stdio: tools, resources and one prompt. `Err(ErrorData)` is only for input
//! the server cannot route. A successful call returns `CallToolResult::structured`; a failure the
//! model should read is `isError: true` with text.

use std::sync::Arc;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, ContentBlock, ErrorData, GetPromptRequestParams, GetPromptResponse,
    GetPromptResult, Implementation, ListPromptsResult, ListResourceTemplatesResult,
    ListResourcesResult, PaginatedRequestParams, Prompt, PromptArgument, PromptMessage,
    ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult, ResourceContents,
    ResourceTemplate, Role, ServerCapabilities, ServerInfo,
};
use rmcp::service::RequestContext;
use rmcp::{schemars, tool, tool_handler, tool_router, Peer, RoleServer, ServerHandler};
use serde::Deserialize;
use serde_json::Value;

use crate::catalog::inbox;
use crate::catalog::search::SearchMode;
use crate::error::{AppError, AppResult};

use super::engine::{AddRequest, Engine, ListRequest, SearchRequest};
use super::output;

const BOOKMARK_PREFIX: &str = "mynk://bookmark/";
const COLLECTION_PREFIX: &str = "mynk://collection/";

/// What the model is told about this server before its first call.
pub const INSTRUCTIONS: &str = "\
MYNK is the user's own bookmark library on this machine. Use it to find pages they saved earlier \
and to save new ones.

Start with search_bookmarks. Its default hybrid mode also matches by meaning, and keyword matching \
relaxes step by step when nothing matches, so a vague description (\"that article about \
ownership in Rust\") works as a query. Read `note`: it says when the answer was relaxed or when \
the semantic index was unavailable. Narrow with the filters (category, tag, collection_id, \
added_after, added_before, unopened_only, favorites_only) instead of raising the limit, \
then call get_bookmark for the full bookmark. An empty query needs at least one filter; to \
browse without one, call list_recent.

Two limits: lastOpenedAt only records opens from inside MYNK, so null does not mean the user never \
read the page. add_bookmark queues the URL for MYNK instead of writing the library, so a new \
bookmark appears within seconds if the app is open, otherwise at its next launch.";

fn empty_string_is_none(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.trim().is_empty())
}

// `mode` stays a `String` so a bad value gets the engine's message. This enum only lists the values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, schemars::JsonSchema)]
#[schemars(rename_all = "lowercase", inline)]
pub enum SearchModeArg {
    Hybrid,
    Keyword,
    Semantic,
}

impl SearchModeArg {
    pub fn as_str(self) -> &'static str {
        match self {
            SearchModeArg::Hybrid => SearchMode::Hybrid.as_str(),
            SearchModeArg::Keyword => SearchMode::Keyword.as_str(),
            SearchModeArg::Semantic => SearchMode::Semantic.as_str(),
        }
    }
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct SearchArgs {
    /// What to look for. Free text; with an empty query at least one filter is required.
    #[serde(default)]
    pub query: String,
    /// How to match: "hybrid" (default, keyword and meaning combined), "keyword" (words only, does
    /// not use the embedding index) or "semantic" (meaning only, needs the index).
    #[serde(default)]
    #[schemars(with = "Option<SearchModeArg>")]
    pub mode: Option<String>,
    /// How many hits to return (1-100, default 20).
    #[serde(default)]
    pub limit: Option<u32>,
    /// Only this category id (as reported by list_categories).
    #[serde(default)]
    pub category: Option<String>,
    /// Only bookmarks with this tag.
    #[serde(default)]
    pub tag: Option<String>,
    /// Only members of this collection (as reported by list_collections).
    #[serde(default)]
    pub collection_id: Option<String>,
    /// Only bookmarks added at or after this time: ISO-8601, or a period like "7d" / "24h".
    #[serde(default)]
    pub added_after: Option<String>,
    /// Only bookmarks added at or before this time: ISO-8601, or a period like "7d" / "24h".
    #[serde(default)]
    pub added_before: Option<String>,
    /// Only bookmarks never opened from inside MYNK.
    #[serde(default)]
    pub unopened_only: bool,
    /// Only bookmarks the user marked as a favorite.
    #[serde(default)]
    pub favorites_only: bool,
}

impl From<SearchArgs> for SearchRequest {
    fn from(args: SearchArgs) -> Self {
        Self {
            query: args.query,
            mode: empty_string_is_none(args.mode),
            limit: args.limit,
            category: empty_string_is_none(args.category),
            tag: empty_string_is_none(args.tag),
            collection_id: empty_string_is_none(args.collection_id),
            added_after: empty_string_is_none(args.added_after),
            added_before: empty_string_is_none(args.added_before),
            unopened_only: args.unopened_only,
            favorites_only: args.favorites_only,
        }
    }
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct GetArgs {
    /// The bookmark's id, or its URL (scheme, "www." and a trailing slash do not matter).
    pub id_or_url: String,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct RecentArgs {
    /// How far back to look, in days (default 7). Ignored when `since` is given.
    #[serde(default)]
    pub days: Option<u32>,
    /// Look back to this time instead: ISO-8601, or a period like "7d".
    #[serde(default)]
    pub since: Option<String>,
    /// How many bookmarks to return (1-100, default 20).
    #[serde(default)]
    pub limit: Option<u32>,
    /// Only bookmarks never opened from inside MYNK.
    #[serde(default)]
    pub unopened_only: bool,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct UnopenedArgs {
    /// How far back to look, in days (default 7).
    #[serde(default)]
    pub days: Option<u32>,
    /// How many bookmarks to return (1-100, default 20).
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct AddArgs {
    /// The http(s) URL to save.
    pub url: String,
    /// A title. If left out, MYNK takes it from the page.
    #[serde(default)]
    pub title: Option<String>,
    /// Tags to save it under.
    #[serde(default)]
    pub tags: Vec<String>,
    /// A short note about why it was saved.
    #[serde(default)]
    pub note: Option<String>,
}

/// The MCP server. Cheap to clone: the library cache lives behind the `Arc`.
#[derive(Debug, Clone)]
pub struct MynkServer {
    engine: Arc<Engine>,
    tool_router: ToolRouter<Self>,
}

/// Input the server cannot route. Everything else is a readable tool failure; a damaged
/// `library.json` is `parse`, which is not the caller's fault.
fn protocol_error(error: &AppError) -> bool {
    error.kind() == "invalidInput"
}

/// Turns an [`AppResult`] into an MCP tool answer.
fn answer(result: AppResult<Value>) -> Result<CallToolResult, ErrorData> {
    match result {
        Ok(value) => Ok(CallToolResult::structured(value)),
        Err(error) if protocol_error(&error) => {
            Err(ErrorData::invalid_params(error.to_string(), None))
        }
        Err(error) => Ok(CallToolResult::error(vec![ContentBlock::text(
            error.to_string(),
        )])),
    }
}

const SOURCE_PREFIX: &str = "mcp:";

/// `mcp:<client name>`. The client picks the name, so characters the inbox refuses are removed and
/// the source is cut to [`inbox::MAX_SOURCE_CHARS`]. An empty result becomes `unknown`.
fn source_from_name(raw: &str) -> String {
    let room = inbox::MAX_SOURCE_CHARS.saturating_sub(SOURCE_PREFIX.chars().count());
    let name: String = raw
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(room)
        .collect();
    let name = name.trim();
    if name.is_empty() {
        format!("{SOURCE_PREFIX}unknown")
    } else {
        format!("{SOURCE_PREFIX}{name}")
    }
}

/// The source recorded for the peer that connected.
fn source_of(peer: &Peer<RoleServer>) -> String {
    source_from_name(
        &peer
            .peer_info()
            .map(|info| info.client_info.name.clone())
            .unwrap_or_default(),
    )
}

#[tool_router]
impl MynkServer {
    pub fn new(engine: Arc<Engine>) -> Self {
        Self {
            engine,
            tool_router: Self::tool_router(),
        }
    }

    #[tool(
        name = "search_bookmarks",
        description = "Search the user's saved bookmarks by meaning and by keyword. Returns ranked \
                       hits and the mode that ran. If the semantic index is unavailable, it \
                       falls back to keyword matching and says so in `note`. A whole sentence \
                       works as a query, since keyword matching relaxes step by step when nothing \
                       matches. An empty query needs at least one filter; use list_recent to \
                       browse.",
        output_schema = output::schema::of::<output::schema::SearchAnswer>()
    )]
    async fn search_bookmarks(
        &self,
        Parameters(args): Parameters<SearchArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        answer(self.engine.search(&SearchRequest::from(args)).await)
    }

    #[tool(
        name = "get_bookmark",
        description = "Fetch one bookmark in full by its id or URL, including its tags, summary, \
                       analysis state and last link check.",
        output_schema = output::schema::of::<output::schema::BookmarkDetail>()
    )]
    async fn get_bookmark(
        &self,
        Parameters(args): Parameters<GetArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        answer(self.engine.get(&args.id_or_url))
    }

    #[tool(
        name = "list_recent",
        description = "List recently added bookmarks, newest first. Defaults to the last 7 days.",
        output_schema = output::schema::of::<output::schema::ListAnswer>()
    )]
    async fn list_recent(
        &self,
        Parameters(args): Parameters<RecentArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        answer(self.engine.recent(&ListRequest {
            days: args.days,
            since: empty_string_is_none(args.since),
            limit: args.limit,
            unopened_only: args.unopened_only,
        }))
    }

    #[tool(
        name = "list_unopened",
        description = "List bookmarks that were added but never opened from inside MYNK. Browser \
                       visits are not recorded, so the user may still have read them.",
        output_schema = output::schema::of::<output::schema::ListAnswer>()
    )]
    async fn list_unopened(
        &self,
        Parameters(args): Parameters<UnopenedArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        answer(self.engine.unopened(&ListRequest {
            days: args.days,
            since: None,
            limit: args.limit,
            unopened_only: true,
        }))
    }

    #[tool(
        name = "list_collections",
        description = "List the user's collections with how many bookmarks belong to each.",
        output_schema = output::schema::of::<output::schema::CollectionsAnswer>()
    )]
    async fn list_collections(&self) -> Result<CallToolResult, ErrorData> {
        answer(self.engine.collections())
    }

    #[tool(
        name = "list_tags",
        description = "List every tag in the library with how many bookmarks carry it.",
        output_schema = output::schema::of::<output::schema::TagsAnswer>()
    )]
    async fn list_tags(&self) -> Result<CallToolResult, ErrorData> {
        answer(self.engine.tags())
    }

    #[tool(
        name = "list_categories",
        description = "List the category ids in use with how many bookmarks are in each. Use one \
                       of these ids as the `category` filter of search_bookmarks.",
        output_schema = output::schema::of::<output::schema::CategoriesAnswer>()
    )]
    async fn list_categories(&self) -> Result<CallToolResult, ErrorData> {
        answer(self.engine.categories())
    }

    #[tool(
        name = "library_stats",
        description = "Summarize the library: totals, category spread, how much has been analyzed, \
                       broken links, and whether the MYNK app is currently open.",
        output_schema = output::schema::of::<output::schema::StatsAnswer>()
    )]
    async fn library_stats(&self) -> Result<CallToolResult, ErrorData> {
        answer(self.engine.stats())
    }

    #[tool(
        name = "add_bookmark",
        description = "Save a URL to the user's library. The bookmark is queued for MYNK: it \
                       appears within seconds while the app is open, otherwise at its next launch.",
        output_schema = output::schema::of::<output::schema::AddAnswer>()
    )]
    async fn add_bookmark(
        &self,
        peer: Peer<RoleServer>,
        Parameters(args): Parameters<AddArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        answer(self.engine.add(&AddRequest {
            url: args.url,
            title: empty_string_is_none(args.title),
            tags: args.tags,
            note: empty_string_is_none(args.note),
            source: source_of(&peer),
        }))
    }
}

/// A prompt for when the user cannot name the page they are looking for.
fn find_bookmark_prompt() -> Prompt {
    Prompt::new(
        "find_bookmark",
        Some("Find a bookmark the user only half remembers"),
        Some(vec![PromptArgument::new("description")
            .with_description("What the user remembers about the page, in their own words")
            .with_required(false)]),
    )
}

fn find_bookmark_messages(description: Option<&str>) -> Vec<PromptMessage> {
    let described = description.unwrap_or("").trim();
    let opening = if described.is_empty() {
        "I am looking for a page I saved in MYNK but I cannot remember its name.".to_string()
    } else {
        format!("I am looking for a page I saved in MYNK. All I remember is: {described}")
    };
    vec![PromptMessage::new_text(
        Role::User,
        format!(
            "{opening}\n\n\
             Please find it this way:\n\
             1. Call search_bookmarks with my description as the query and mode \"hybrid\", so \
             wording I got wrong still matches by meaning.\n\
             2. If nothing fits, try again with the distinctive words only, or narrow with \
             `category`, `tag` or `added_after` instead of raising `limit`.\n\
             3. Call get_bookmark on the best hit and show me its title, URL and summary before I \
             open anything.\n\
             4. If several hits could fit, list them and let me choose."
        ),
    )]
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for MynkServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .enable_prompts()
                .build(),
        )
        .with_server_info(Implementation::new("mynk", env!("CARGO_PKG_VERSION")))
        .with_instructions(INSTRUCTIONS)
    }

    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        Ok(ListResourceTemplatesResult::with_all_items(vec![
            ResourceTemplate::new(format!("{BOOKMARK_PREFIX}{{id}}"), "bookmark")
                .with_title("Bookmark")
                .with_description("One saved bookmark, addressed by its MYNK id")
                .with_mime_type("application/json"),
            ResourceTemplate::new(format!("{COLLECTION_PREFIX}{{id}}"), "collection")
                .with_title("Collection")
                .with_description("A collection and the bookmarks that belong to it")
                .with_mime_type("application/json"),
        ]))
    }

    /// Empty: browse with `search_bookmarks`; the templates above address one item directly.
    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        Ok(ListResourcesResult::default())
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        let uri = request.uri.trim();
        let found = if let Some(id) = uri.strip_prefix(BOOKMARK_PREFIX) {
            self.engine.bookmark_resource(id)
        } else if let Some(id) = uri.strip_prefix(COLLECTION_PREFIX) {
            self.engine.collection_resource(id)
        } else {
            return Err(ErrorData::resource_not_found(
                format!("Unknown resource URI \"{uri}\"; expected {BOOKMARK_PREFIX}{{id}} or {COLLECTION_PREFIX}{{id}}."),
                None,
            ));
        };
        match found {
            Ok(value) => Ok(ReadResourceResult::new(vec![ResourceContents::text(
                value.to_string(),
                uri,
            )
            .with_mime_type("application/json")])
            .into()),
            Err(error) => Err(ErrorData::resource_not_found(error.to_string(), None)),
        }
    }

    async fn list_prompts(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, ErrorData> {
        Ok(ListPromptsResult::with_all_items(vec![
            find_bookmark_prompt(),
        ]))
    }

    async fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<GetPromptResponse, ErrorData> {
        if request.name != "find_bookmark" {
            return Err(ErrorData::invalid_params(
                format!("Unknown prompt \"{}\".", request.name),
                None,
            ));
        }
        let description = request
            .arguments
            .as_ref()
            .and_then(|arguments| arguments.get("description"))
            .and_then(Value::as_str);
        Ok(GetPromptResult::new(find_bookmark_messages(description))
            .with_description("Find a bookmark the user only half remembers")
            .into())
    }
}

/// Serves MCP on stdin/stdout until the client disconnects.
pub async fn serve_stdio(engine: Arc<Engine>) -> Result<(), Box<dyn std::error::Error>> {
    use rmcp::ServiceExt;

    let service = MynkServer::new(engine)
        .serve(rmcp::transport::stdio())
        .await?;
    service.waiting().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::engine::{DEFAULT_LIMIT, MAX_LIMIT};

    #[test]
    fn the_tool_surface_is_the_one_that_was_designed() {
        let tools = MynkServer::tool_router();
        let mut names: Vec<String> = tools
            .list_all()
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "add_bookmark",
                "get_bookmark",
                "library_stats",
                "list_categories",
                "list_collections",
                "list_recent",
                "list_tags",
                "list_unopened",
                "search_bookmarks",
            ]
        );
    }

    #[test]
    fn every_tool_describes_itself() {
        for tool in MynkServer::tool_router().list_all() {
            let description = tool.description.as_deref().unwrap_or_default();
            assert!(
                description.len() > 30,
                "{} needs a description a model can act on",
                tool.name
            );
        }
    }

    #[test]
    fn the_search_schema_advertises_every_filter() {
        let tool = MynkServer::search_bookmarks_tool_attr();
        let properties = tool.input_schema["properties"]
            .as_object()
            .expect("an object schema");
        for field in [
            "query",
            "mode",
            "limit",
            "category",
            "tag",
            "collection_id",
            "added_after",
            "added_before",
            "unopened_only",
            "favorites_only",
        ] {
            assert!(properties.contains_key(field), "{field} is missing");
        }
    }

    #[test]
    fn server_info_tells_an_agent_what_this_is() {
        let dir = tempfile::tempdir().expect("temp dir");
        let server = MynkServer::new(Arc::new(Engine::new(dir.path(), dir.path())));
        let info = server.get_info();
        assert_eq!(info.server_info.name, "mynk");
        assert_eq!(info.server_info.version, env!("CARGO_PKG_VERSION"));
        assert!(info.capabilities.tools.is_some());
        assert!(info.capabilities.resources.is_some());
        assert!(info.capabilities.prompts.is_some());
        let instructions = info.instructions.unwrap_or_default();
        assert!(instructions.contains("search_bookmarks"), "{instructions}");
        assert!(instructions.contains("lastOpenedAt"), "{instructions}");
    }

    #[test]
    fn input_errors_are_protocol_errors_and_missing_records_are_readable_ones() {
        assert!(protocol_error(&AppError::invalid_input("nope")));
        assert!(!protocol_error(&AppError::NotFound("nope".into())));
        assert!(!protocol_error(&AppError::storage("nope")));
        assert!(
            !protocol_error(&AppError::Parse("library.json is damaged".into())),
            "an unreadable library is not the caller's argument"
        );

        let damaged = answer(Err(AppError::Parse("library.json is damaged".into())))
            .expect("a damaged library reads as a tool failure");
        assert_eq!(damaged.is_error, Some(true));

        let refused = answer(Err(AppError::invalid_input("mode must be hybrid")));
        assert!(refused.is_err(), "the request could not be routed");

        let missing = answer(Err(AppError::NotFound("No bookmark matches \"x\".".into())))
            .expect("a readable failure is still a successful call");
        assert_eq!(missing.is_error, Some(true));
        let text = missing
            .content
            .first()
            .and_then(|block| block.as_text())
            .map(|text| text.text.clone())
            .unwrap_or_default();
        assert!(text.contains("No bookmark matches"), "{text}");

        let ok = answer(Ok(serde_json::json!({ "total": 0 }))).expect("success");
        assert_eq!(ok.is_error, Some(false));
        assert_eq!(
            ok.structured_content,
            Some(serde_json::json!({ "total": 0 }))
        );
    }

    /// The client picks its own name, so `add_bookmark` must not fail because of it.
    #[test]
    fn a_client_name_is_clipped_and_stripped_into_a_source_the_inbox_accepts() {
        assert_eq!(source_from_name("claude-code"), "mcp:claude-code");
        assert_eq!(source_from_name("  "), "mcp:unknown");
        assert_eq!(source_from_name(""), "mcp:unknown");
        assert_eq!(source_from_name("a\u{202e}b\u{7}c"), "mcp:abc");
        assert_eq!(source_from_name("\u{202e}\u{7}"), "mcp:unknown");

        let long = source_from_name(&"n".repeat(200));
        assert_eq!(long.chars().count(), inbox::MAX_SOURCE_CHARS);
        for raw in ["claude-code", "", &"n".repeat(200), "a\u{202e}b"] {
            let entry = inbox::InboxEntry::new("https://example.com/a", source_from_name(raw));
            let stored = inbox::validate(&entry).expect("the inbox accepts every sanitized source");
            assert!(stored.source.starts_with("mcp:"), "{stored:?}");
        }
    }

    #[test]
    fn the_prompt_walks_a_model_through_the_two_step_lookup() {
        let prompt = find_bookmark_prompt();
        assert_eq!(prompt.name, "find_bookmark");
        let arguments = prompt.arguments.unwrap_or_default();
        assert_eq!(arguments[0].name, "description");
        assert_eq!(arguments[0].required, Some(false));

        let messages = find_bookmark_messages(Some("  an article about ownership  "));
        let text = messages
            .first()
            .and_then(|message| message.content.as_text())
            .map(|text| text.text.clone())
            .unwrap_or_default();
        assert!(text.contains("an article about ownership"), "{text}");
        assert!(text.contains("search_bookmarks"), "{text}");
        assert!(text.contains("hybrid"), "{text}");
        assert!(text.contains("get_bookmark"), "{text}");

        let text = find_bookmark_messages(None)
            .first()
            .and_then(|message| message.content.as_text())
            .map(|text| text.text.clone())
            .unwrap_or_default();
        assert!(text.contains("cannot remember its name"), "{text}");
    }

    #[test]
    fn blank_optional_strings_are_dropped_rather_than_filtered_on() {
        assert_eq!(empty_string_is_none(Some("  ".into())), None);
        assert_eq!(empty_string_is_none(None), None);
        assert_eq!(
            empty_string_is_none(Some(" rust ".into())).as_deref(),
            Some(" rust ")
        );
        let request = SearchRequest::from(SearchArgs {
            query: "rust".into(),
            mode: Some(String::new()),
            category: Some("   ".into()),
            ..SearchArgs::default()
        });
        assert_eq!(request.mode, None, "an empty mode means the default");
        assert_eq!(request.category, None);
        assert_eq!(request.limit, None);
    }

    #[test]
    fn the_mode_argument_is_an_enumeration_in_the_schema() {
        let tool = MynkServer::search_bookmarks_tool_attr();
        let declared =
            serde_json::to_string(&tool.input_schema["properties"]["mode"]).expect("json");
        assert!(
            !declared.contains("$ref"),
            "the values are written out, not referenced: {declared}"
        );
        assert!(
            declared.contains(r#""enum":["hybrid","keyword","semantic",null]"#),
            "{declared}"
        );

        for (arg, mode) in [
            (SearchModeArg::Hybrid, SearchMode::Hybrid),
            (SearchModeArg::Keyword, SearchMode::Keyword),
            (SearchModeArg::Semantic, SearchMode::Semantic),
        ] {
            assert_eq!(arg.as_str(), mode.as_str());
            assert_eq!(SearchMode::parse(arg.as_str()), Some(mode));
            assert!(
                declared.contains(&format!("\"{}\"", arg.as_str())),
                "{declared}"
            );
        }

        let args: SearchArgs =
            serde_json::from_value(serde_json::json!({ "query": "rust", "mode": "keyword" }))
                .expect("deserialize");
        assert_eq!(
            SearchRequest::from(args).mode.as_deref(),
            Some("keyword"),
            "the value reaches the engine, which is what validates it"
        );
    }

    #[test]
    fn every_tool_declares_an_output_schema() {
        for tool in MynkServer::tool_router().list_all() {
            let schema = tool
                .output_schema
                .as_ref()
                .unwrap_or_else(|| panic!("{} has no output schema", tool.name));
            assert_eq!(
                schema.get("type").and_then(|value| value.as_str()),
                Some("object"),
                "{}",
                tool.name
            );
            assert!(
                schema
                    .get("properties")
                    .and_then(|value| value.as_object())
                    .is_some_and(|properties| !properties.is_empty()),
                "{} declares an empty answer",
                tool.name
            );
        }
    }

    #[test]
    fn the_limits_the_schema_promises_match_the_engine() {
        assert_eq!(DEFAULT_LIMIT, 20);
        assert_eq!(MAX_LIMIT, 100);
        let tool = MynkServer::search_bookmarks_tool_attr();
        let description = tool.input_schema["properties"]["limit"]["description"]
            .as_str()
            .unwrap_or_default();
        assert!(description.contains("1-100"), "{description}");
        assert!(description.contains("default 20"), "{description}");
    }
}
