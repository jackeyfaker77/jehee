Feature: Portable live web search via TinyFish TinySearch (Slice 6D-1)
  As a Jehee owner
  I want Jehee to search the live web via TinyFish and follow up with SSRF-guarded web_fetch
  So that I can ask about up-to-date facts without manually providing URLs

  Scenario: Jehee chains web_search into web_fetch to answer a live question
    Given a JeheeHost configured with TinyFish web_search and web_fetch
    When the user asks Jehee to search for "Cloudflare Durable Objects SQLite" and read the top result
    Then Jehee should call web_search with the X-API-Key header and then fetch the discovered public URL
    And Jehee should answer using both the search hit and fetched page content

  Scenario: Jehee redacts TinyFish credentials when the search API returns HTTP 429
    Given a JeheeHost configured with TinyFish web_search returning rate limit errors
    When the user asks Jehee to search for "breaking news"
    Then the web_search tool result should report "rate_limited" without leaking the API key
