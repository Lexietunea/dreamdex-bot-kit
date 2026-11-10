// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DecisionJournal
/// @notice Public, append-only log of every decision a trading bot makes:
///         trades it placed AND trades it refused (with a reason code).
///         The bot first publishes its rule set, then every entry is stamped
///         with that rule set's hash so anyone can verify which rules were in force.
contract DecisionJournal {
    enum Action { TRADE, REFUSED }
    enum Side { NONE, LONG, SHORT }
    enum Reason {
        NONE,               // used for TRADE entries
        MAX_LEVERAGE,
        MAX_SIZE,
        MAX_OPEN_POSITIONS,
        COOLDOWN,
        MAX_SPREAD,
        RISK_PER_TRADE,
        DAILY_LOSS,
        STALE_DATA,
        OTHER
    }

    struct Entry {
        uint64 timestamp;
        Action action;
        Side side;
        Reason reason;
        bytes32 market;     // e.g. bytes32("ETH-PERP")
        bytes32 ruleHash;   // keccak256 of the rule-set JSON active at the time
        bytes32 ref;        // order id / tx hash for TRADE, signal id for REFUSED
        string note;        // short human-readable detail, e.g. "spread 18bps > 10bps"
    }

    address public owner;
    mapping(address => bool) public isWriter;
    bytes32 public activeRuleHash;
    Entry[] private _entries;

    event WriterSet(address indexed writer, bool allowed);
    event RulesPublished(bytes32 indexed ruleHash, address indexed writer, string rulesJson);
    event EntryLogged(
        uint256 indexed id,
        bytes32 indexed market,
        Action indexed action,
        Reason reason,
        Side side,
        bytes32 ruleHash,
        bytes32 ref,
        string note
    );

    error NotOwner();
    error NotWriter();
    error NoActiveRules();
    error InvalidReason();
    error EmptyRules();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyWriter() {
        if (!isWriter[msg.sender]) revert NotWriter();
        _;
    }

    constructor() {
        owner = msg.sender;
        isWriter[msg.sender] = true;
        emit WriterSet(msg.sender, true);
    }

    /// @notice Authorize (or revoke) the bot's address to write entries.
    function setWriter(address writer, bool allowed) external onlyOwner {
        isWriter[writer] = allowed;
        emit WriterSet(writer, allowed);
    }

    /// @notice Publish the rule set the bot is about to run. The full JSON is
    ///         emitted in an event; only its hash is stored.
    function publishRules(string calldata rulesJson) external onlyWriter returns (bytes32 ruleHash) {
        if (bytes(rulesJson).length == 0) revert EmptyRules();
        ruleHash = keccak256(bytes(rulesJson));
        activeRuleHash = ruleHash;
        emit RulesPublished(ruleHash, msg.sender, rulesJson);
    }

    /// @notice Record one decision. TRADE must use Reason.NONE; REFUSED must give a reason.
    function log(
        Action action,
        Side side,
        Reason reason,
        bytes32 market,
        bytes32 ref,
        string calldata note
    ) external onlyWriter returns (uint256 id) {
        if (activeRuleHash == bytes32(0)) revert NoActiveRules();
        if (action == Action.TRADE && reason != Reason.NONE) revert InvalidReason();
        if (action == Action.REFUSED && reason == Reason.NONE) revert InvalidReason();

        id = _entries.length;
        _entries.push(Entry({
            timestamp: uint64(block.timestamp),
            action: action,
            side: side,
            reason: reason,
            market: market,
            ruleHash: activeRuleHash,
            ref: ref,
            note: note
        }));

        emit EntryLogged(id, market, action, reason, side, activeRuleHash, ref, note);
    }

    function entryCount() external view returns (uint256) {
        return _entries.length;
    }

    function getEntry(uint256 id) external view returns (Entry memory) {
        return _entries[id];
    }

    /// @notice Paginated read for the dashboard (oldest first).
    function getEntries(uint256 offset, uint256 limit) external view returns (Entry[] memory page) {
        uint256 total = _entries.length;
        if (offset >= total) return new Entry[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new Entry[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = _entries[i];
        }
    }
}
