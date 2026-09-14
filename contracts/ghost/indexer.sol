// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "./gen_schema.sol";
import "./gen_events.sol";
import "./gen_base.sol";
import "./gen_helpers.sol";

/// Indexer GhostGraph untuk BeeworkEscrow. Ganti alamat di bawah dengan kontrak Anda.
contract BeeworkEscrowIndex is GhostGraph {
    using StringHelpers for EventDetails;
    using StringHelpers for uint256;
    using StringHelpers for address;

    address constant ESCROW = 0x869F8D2Ab4D8a60063e9F4B9D967D835eFf5f470;

    function registerHandles() external {
        graph.registerHandle(ESCROW);
    }

    function _walletAssetId(address wallet, address asset) internal pure returns (string memory) {
        return string.concat(wallet.toString(), "-", asset.toString());
    }

    function _baseEvent(EventDetails memory d, string memory kind) internal returns (EscrowEvent memory) {
        EscrowEvent memory e = graph.getEscrowEvent(d.uniqueId());
        e.kind = kind;
        e.block = d.block;
        e.logIndex = d.logIndex;
        e.transactionHash = d.transactionHash;
        e.timestamp = d.timestamp;
        return e;
    }

    function onBountyFunded(EventDetails memory d, BountyFundedEvent memory ev) external {
        EscrowEvent memory e = _baseEvent(d, "BountyFunded");
        e.bountyId = ev.bountyId;
        e.taskId = ev.taskId;
        e.creator = ev.creator;
        e.reviewer = ev.reviewer;
        e.asset = ev.asset;
        e.amount = ev.budget;
        e.fee = ev.fee;
        e.deadline = ev.deadline;
        e.refundAt = ev.refundAt;
        e.maxWinners = ev.maxWinners;
        graph.saveEscrowEvent(e);

        Bounty memory b = graph.getBounty(ev.bountyId);
        b.taskId = ev.taskId;
        b.creator = ev.creator;
        b.reviewer = ev.reviewer;
        b.asset = ev.asset;
        b.budget = ev.budget;
        b.fee = ev.fee;
        b.maxWinners = ev.maxWinners;
        b.deadline = ev.deadline;
        b.refundAt = ev.refundAt;
        b.fundedBlock = d.block;
        graph.saveBounty(b);

        WalletAsset memory w = graph.getWalletAsset(_walletAssetId(ev.creator, ev.asset));
        w.wallet = ev.creator;
        w.asset = ev.asset;
        w.funded += ev.budget + ev.fee;
        graph.saveWalletAsset(w);
    }

    function onRewardAllocated(EventDetails memory d, RewardAllocatedEvent memory ev) external {
        EscrowEvent memory e = _baseEvent(d, "RewardAllocated");
        e.bountyId = ev.bountyId;
        e.submissionId = ev.submissionId;
        e.winner = ev.winner;
        e.asset = ev.asset;
        e.amount = ev.reward;
        e.fee = ev.fee;
        graph.saveEscrowEvent(e);

        Bounty memory b = graph.getBounty(ev.bountyId);
        b.awarded += ev.reward;
        b.feeCharged += ev.fee;
        b.winners += 1;
        if (b.awarded == b.budget) b.closed = true;
        graph.saveBounty(b);

        WalletAsset memory w = graph.getWalletAsset(_walletAssetId(ev.winner, ev.asset));
        w.wallet = ev.winner;
        w.asset = ev.asset;
        w.awarded += ev.reward;
        graph.saveWalletAsset(w);
    }

    function onBountyRefunded(EventDetails memory d, BountyRefundedEvent memory ev) external {
        EscrowEvent memory e = _baseEvent(d, "BountyRefunded");
        e.bountyId = ev.bountyId;
        e.creator = ev.creator;
        e.asset = ev.asset;
        e.amount = ev.amount;
        graph.saveEscrowEvent(e);

        Bounty memory b = graph.getBounty(ev.bountyId);
        b.closed = true;
        b.refunded = true;
        graph.saveBounty(b);

        WalletAsset memory w = graph.getWalletAsset(_walletAssetId(ev.creator, ev.asset));
        w.wallet = ev.creator;
        w.asset = ev.asset;
        w.refunded += ev.amount;
        graph.saveWalletAsset(w);
    }

    function onWithdrawn(EventDetails memory d, WithdrawnEvent memory ev) external {
        EscrowEvent memory e = _baseEvent(d, "Withdrawn");
        e.account = ev.account;
        e.recipient = ev.recipient;
        e.asset = ev.asset;
        e.amount = ev.amount;
        graph.saveEscrowEvent(e);

        WalletAsset memory w = graph.getWalletAsset(_walletAssetId(ev.account, ev.asset));
        w.wallet = ev.account;
        w.asset = ev.asset;
        w.withdrawn += ev.amount;
        graph.saveWalletAsset(w);
    }
}
