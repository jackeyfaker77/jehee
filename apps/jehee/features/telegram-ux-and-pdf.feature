Feature: Telegram UX completeness and portable PDF text reading (Slice 6D-2)
  As a Jehee owner using Telegram daily
  I want Jehee to preserve quoted replies and forwarded message origins, register the slash command menu, and extract text from inbound PDF documents
  So that forwarding bills, quoting old messages, and invoking commands feel native and effortless

  Scenario: Quoted reply and forwarded channel origin are preserved into the model prompt
    Given a ChannelGateway connected to JeheeHost for Telegram UX testing
    When the owner sends a Telegram message quoting an earlier reply and another message forwarded from a channel
    Then Jehee should receive both the quoted excerpt and the forwarded channel attribution in context

  Scenario: Inbound PDF document with FlateDecode and ToUnicode CMap is extracted cleanly
    Given a ChannelGateway connected to JeheeHost with a compressed CJK PDF attachment
    When the owner sends the PDF document over Telegram
    Then Jehee should receive the extracted Chinese and Latin PDF text in context

  Scenario: TelegramTransport registers all Jehee slash commands via setMyCommands
    When TelegramTransport registers the default Jehee bot command menu
    Then Telegram Bot API setMyCommands should receive all 11 valid Jehee slash commands
