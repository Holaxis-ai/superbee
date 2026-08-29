/**
 * Pure verifier for an interview-designed workspace proposal and its delivery receipt.
 * The private dogfood harness can reuse this module with the artifact-carried JSON scenario.
 */

export const MODELING_INTERVIEW_CONTRACT_VERSION = 1;

export const REQUIRED_PROPOSAL_CATEGORIES = Object.freeze([
  "recurring_concepts",
  "relationships_and_provenance",
  "records_to_create_now",
  "candidate_kinds",
  "workflow",
  "unstructured_material",
  "privacy_and_sharing_boundary",
]);

export function verifyModelingInterviewDelivery(proposal, delivery) {
  const failures = [];
  const reject = (id, detail) => failures.push({ id, detail });

  if (!isRecord(proposal)) {
    reject("proposal.invalid", "proposal must be an object");
    return result(failures);
  }
  if (proposal.schema_version !== MODELING_INTERVIEW_CONTRACT_VERSION) {
    reject("proposal.schema_version", "proposal schema_version must be 1");
  }
  const approval = isRecord(proposal.approval) ? proposal.approval : {};
  if (approval.approved !== true || !isText(approval.version)) {
    reject("proposal.not_approved", "proposal requires an approved immutable version");
  }

  const categories = isRecord(proposal.categories) ? proposal.categories : {};
  for (const category of REQUIRED_PROPOSAL_CATEGORIES) {
    if (!Object.hasOwn(categories, category)) {
      reject("proposal.category_missing", `missing proposal category ${category}`);
    }
  }
  for (const category of REQUIRED_PROPOSAL_CATEGORIES.slice(0, -1)) {
    if (Object.hasOwn(categories, category) && !Array.isArray(categories[category])) {
      reject("proposal.category_invalid", `${category} must be an explicit array`);
    }
  }
  if (Object.hasOwn(categories, "privacy_and_sharing_boundary") &&
    !isText(categories.privacy_and_sharing_boundary)) {
    reject("proposal.category_invalid", "privacy_and_sharing_boundary must be explicit text");
  }

  const records = Array.isArray(categories.records_to_create_now)
    ? categories.records_to_create_now
    : [];
  const requiredRecordIds = uniqueText(records.map((record) => isRecord(record) ? record.id : null));
  if (requiredRecordIds.length !== records.length || requiredRecordIds.length === 0 ||
    records.some((record) => !isRecord(record) || record.representative !== true)) {
    reject("proposal.records_invalid", "records_to_create_now requires unique representative record ids");
  }

  const proposedKinds = Array.isArray(categories.candidate_kinds)
    ? categories.candidate_kinds
    : [];
  const proposalKindByName = new Map();
  for (const candidate of proposedKinds) {
    if (!isRecord(candidate) || !isText(candidate.kind) || proposalKindByName.has(candidate.kind)) {
      reject("proposal.kind_invalid", "candidate Kinds require unique non-empty names");
      continue;
    }
    proposalKindByName.set(candidate.kind, candidate);
    if (candidate.disposition === "install_now") {
      const structure = uniqueText(candidate.declared_structure);
      const evidence = isRecord(candidate.evidence) ? candidate.evidence : {};
      const supported = new Set(uniqueText(evidence.supports));
      if (structure.length === 0 || !hasConcreteEvidence(evidence.sources)) {
        reject(
          "proposal.kind_evidence_missing",
          `${candidate.kind} install_now requires declared structure and concrete prior evidence`,
        );
      }
      if (structure.some((item) => !supported.has(item))) {
        reject(
          "proposal.kind_evidence_incomplete",
          `${candidate.kind} evidence must cover every declared structure token`,
        );
      }
    } else if (candidate.disposition === "defer") {
      if (!isText(candidate.stabilizing_trigger)) {
        reject("proposal.kind_trigger_missing", `${candidate.kind} defer requires a stabilizing trigger`);
      }
    } else {
      reject(
        "proposal.kind_disposition_missing",
        `${candidate.kind} must be proposed as install_now or defer before approval`,
      );
    }
  }

  if (!isRecord(delivery)) {
    reject("delivery.invalid", "delivery receipt must be an object");
    return result(failures);
  }
  if (delivery.schema_version !== MODELING_INTERVIEW_CONTRACT_VERSION) {
    reject("delivery.schema_version", "delivery schema_version must be 1");
  }
  if (!isText(approval.version) || delivery.approved_proposal_version !== approval.version) {
    reject(
      "delivery.approval_version_mismatch",
      "delivery must cite the exact proposal version approved by the user",
    );
  }

  const deliveredRecordIds = new Set(uniqueText(delivery.delivered_record_ids));
  const missingRecords = requiredRecordIds.filter((id) => !deliveredRecordIds.has(id));
  for (const id of missingRecords) {
    reject("delivery.record_missing", `approved representative record ${id} was not delivered`);
  }
  if (missingRecords.length > 0 && uniqueText(delivery.overview_ids).length > 0) {
    reject(
      "delivery.overview_substitution",
      "an overview cannot substitute for approved representative records",
    );
  }

  const deliveredKinds = Array.isArray(delivery.kind_dispositions)
    ? delivery.kind_dispositions
    : [];
  const deliveredKindByName = new Map();
  for (const candidate of deliveredKinds) {
    if (!isRecord(candidate) || !isText(candidate.kind) || deliveredKindByName.has(candidate.kind)) {
      reject("delivery.kind_invalid", "delivery Kind dispositions require unique non-empty names");
      continue;
    }
    deliveredKindByName.set(candidate.kind, candidate);
    const approved = proposalKindByName.get(candidate.kind);
    if (!approved) {
      reject(
        candidate.disposition === "install_now"
          ? "delivery.unsupported_kind_installation"
          : "delivery.unapproved_kind_disposition",
        `${candidate.kind} was not present in the approved proposal`,
      );
      continue;
    }
    if (candidate.disposition !== approved.disposition) {
      reject(
        "delivery.kind_disposition_drift",
        `${candidate.kind} changed from ${approved.disposition} to ${candidate.disposition} after approval`,
      );
      continue;
    }
    if (candidate.disposition === "install_now") {
      const approvedEvidence = isRecord(approved.evidence) ? approved.evidence : {};
      if (!sameTextSet(candidate.declared_structure, approved.declared_structure) ||
        !sameEvidenceSources(candidate.evidence_sources, approvedEvidence.sources)) {
        reject(
          "delivery.kind_evidence_drift",
          `${candidate.kind} installation did not match its approved structure and evidence`,
        );
      }
    } else if (candidate.disposition === "defer" &&
      candidate.stabilizing_trigger !== approved.stabilizing_trigger) {
      reject(
        "delivery.kind_trigger_drift",
        `${candidate.kind} deferral trigger did not match the approved proposal`,
      );
    }
  }
  for (const kind of proposalKindByName.keys()) {
    if (!deliveredKindByName.has(kind)) {
      reject("delivery.kind_disposition_missing", `${kind} has no delivery disposition`);
    }
  }
  const expectedInstalls = new Set([...proposalKindByName.values()]
    .filter((candidate) => candidate.disposition === "install_now")
    .map((candidate) => candidate.kind));
  const installedKinds = new Set(uniqueText(delivery.installed_kind_names));
  for (const kind of installedKinds) {
    if (!expectedInstalls.has(kind)) {
      reject(
        "delivery.unsupported_kind_installation",
        `${kind} was installed without approved install_now disposition`,
      );
    }
  }
  for (const kind of expectedInstalls) {
    if (!installedKinds.has(kind)) {
      reject("delivery.kind_installation_missing", `${kind} was approved for installation but is absent`);
    }
  }

  const health = isRecord(delivery.health) ? delivery.health : {};
  if (health.status_passed !== true || !Array.isArray(health.caused_findings) ||
    health.caused_findings.length !== 0) {
    reject("delivery.health_failed", "bundle health must pass without delivery-caused findings");
  }

  const readBack = isRecord(delivery.read_back) ? delivery.read_back : {};
  const readBackIds = new Set(uniqueText(readBack.record_ids));
  if (requiredRecordIds.some((id) => !readBackIds.has(id)) ||
    (asArray(categories.relationships_and_provenance).length > 0 &&
      readBack.relationships_verified !== true)) {
    reject("delivery.read_back_incomplete", "records and approved relationships require read-back");
  }

  const freshSession = isRecord(delivery.fresh_session) ? delivery.fresh_session : {};
  const freshReadIds = new Set(uniqueText(freshSession.record_ids));
  if (!isText(freshSession.authoring_session_id) || !isText(freshSession.verification_session_id) ||
    freshSession.authoring_session_id === freshSession.verification_session_id ||
    freshSession.workspace_resolved !== true ||
    requiredRecordIds.some((id) => !freshReadIds.has(id))) {
    reject(
      "delivery.fresh_session_incomplete",
      "a distinct fresh session must resolve the workspace and read every representative record",
    );
  }
  if (delivery.claimed_complete !== true) {
    reject("delivery.not_complete", "the journey receipt did not claim completed delivery");
  }

  return result(failures);
}

function result(failures) {
  return { passed: failures.length === 0, failures };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueText(value) {
  return [...new Set(asArray(value).filter(isText))];
}

function sameTextSet(left, right) {
  const a = uniqueText(left).sort();
  const b = uniqueText(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function evidenceSourceKeys(value) {
  return [...new Set(asArray(value).flatMap((source) => {
    if (!isRecord(source) || !["prior_record", "prior_use"].includes(source.class) ||
      !isText(source.id)) return [];
    return [`${source.class}:${source.id}`];
  }))];
}

function sameEvidenceSources(left, right) {
  const a = evidenceSourceKeys(left).sort();
  const b = evidenceSourceKeys(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function hasConcreteEvidence(value) {
  const keys = evidenceSourceKeys(value);
  return keys.some((key) => key.startsWith("prior_use:")) ||
    keys.filter((key) => key.startsWith("prior_record:")).length >= 2;
}
