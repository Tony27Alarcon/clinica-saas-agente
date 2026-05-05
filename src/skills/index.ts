export {
    ADMIN_SKILLS,
    buildAdminSkillsSection,
    buildSkillsByIds,
    buildOnboardingSkillsSection,
} from './admin-agent-skills';
export type { AdminSkill } from './admin-agent-skills';

export { buildBaseAgentSkills } from './base-agent-skills';

export {
    SYSTEM_PATIENT_SKILLS,
    SYSTEM_PATIENT_SKILL_INDEX,
    buildCompanySkillsSection,
} from './system-patient-skills';
export type { PatientSkill } from './system-patient-skills';

export { buildHtmlStylesSkill } from './html-styles.skill';
export type { BrandColors, HtmlStylesContext } from './html-styles.skill';
