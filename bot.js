import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { evaluateInterview } from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, 'data.json');
const DEPARTMENTS = ['Police', 'Fire', 'EMS', 'Dispatcher', 'DOT', 'Judge', 'K9', 'Traffic Enforcement', 'CSI', 'SWAT'];
const NO_EXPERIENCE = new Set(['Police', 'Fire', 'EMS', 'DOT']);
const RANKS = {
  Police: ['Probationary Cadet', 'Cadet', 'Police Officer I', 'Police Officer II', 'Police Officer III', 'Senior Officer', 'Corporal', 'Sergeant', 'Lieutenant', 'Captain', 'Deputy Chief', 'Chief of Police'],
  Fire: ['Probationary Fire Cadet', 'Fire Cadet', 'Firefighter I', 'Firefighter II', 'Firefighter III', 'Engineer', 'Lieutenant', 'Captain', 'Battalion Chief', 'Deputy Chief', 'Fire Chief'],
  EMS: ['Probationary EMT Trainee', 'EMT Trainee', 'EMT', 'Advanced EMT', 'Paramedic', 'Field Supervisor', 'Lieutenant', 'Captain', 'Deputy Chief', 'EMS Chief'],
  DOT: ['Probationary Traffic Officer', 'Traffic Officer I', 'Traffic Officer II', 'Traffic Officer III', 'Senior Traffic Officer', 'Supervisor', 'Area Supervisor', 'Deputy Director', 'Director'],
  Dispatcher: ['Probationary Dispatcher', 'Trainee Dispatcher', 'Dispatcher I', 'Dispatcher II', 'Senior Dispatcher', 'Shift Supervisor', 'Communications Director'],
  Judge: ['Probationary Associate Judge', 'Associate Judge', 'Judge', 'Senior Judge', 'Chief Judge'],
  K9: ['Probationary K9 Handler', 'K9 Handler Trainee', 'K9 Handler', 'Senior K9 Handler', 'K9 Supervisor'],
  'Traffic Enforcement': ['Probationary Traffic Officer', 'Traffic Officer I', 'Traffic Officer II', 'Senior Traffic Officer', 'Sergeant', 'Lieutenant', 'Captain'],
  CSI: ['Probationary CSI Trainee', 'CSI Trainee', 'Crime Scene Investigator I', 'Crime Scene Investigator II', 'Senior Investigator', 'Unit Supervisor'],
  SWAT: ['Probationary Operator', 'SWAT Operator', 'Senior Operator', 'Team Leader', 'Commander'],
};
const PREFIX = { Police: 'A', Fire: 'F', EMS: 'M', Dispatcher: 'D', DOT: 'T', Judge: 'J', K9: 'K9', 'Traffic Enforcement': 'TE', CSI: 'C', SWAT: 'S' };
const emptyData = () => ({ employees: [], applications: [], shifts: [], fto: [], staff: [] });
function loadData() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    return { ...emptyData(), ...parsed };
  } catch {
    return emptyData();
  }
}
let data = loadData();
function saveData() {
  const tempPath = `${DATA_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, DATA_PATH);
}
const stamp = () => new Date().toISOString();
const displayTime = value => new Date(value).toLocaleString();
const envKey = value => value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
const deptRoleEnv = department => process.env[`ROLE_${envKey(department)}`];
const rankRoleEnv = (department, rank) => process.env[`RANK_ROLE_${envKey(department)}_${envKey(rank)}`];
const hrRoleId = process.env.HR_ROLE_ID;
async function hasAnyRole(interaction, roleIds) {
  if (!interaction.guild) return false;
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  return Boolean(member && roleIds.filter(Boolean).some(roleId => member.roles.cache.has(roleId)));
}
const isHr = interaction => hasAnyRole(interaction, [hrRoleId]);
const isStaff = interaction => hasAnyRole(interaction, [hrRoleId, process.env.STAFF_ROLE_ID, process.env.FTO_ROLE_ID]);
const clean = value => String(value ?? '').trim();

const commands = [
  new SlashCommandBuilder().setName('interview').setDescription('Apply to a department').addStringOption(option => option.setName('department').setDescription('Department you want to join').setRequired(true).addChoices(...DEPARTMENTS.map(name => ({ name, value: name })))),
  new SlashCommandBuilder().setName('portal').setDescription('Open the employee and HR portal'),
].map(command => command.toJSON());

async function registerCommands() {
  const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
  if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) throw new Error('Set DISCORD_TOKEN, CLIENT_ID, and GUILD_ID in .env first.');
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log(`Registered ${commands.length} commands for guild ${GUILD_ID}.`);
}

const modalField = (id, label, placeholder, style = TextInputStyle.Short, required = true, maxLength = 500) =>
  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder).setStyle(style).setRequired(required).setMaxLength(maxLength));
function interviewModal(department, staff = false) {
  const modal = new ModalBuilder().setCustomId(staff ? 'staff-interview' : `interview:${department}`).setTitle(staff ? 'Staff access interview' : `${department} interview`);
  modal.addComponents(
    modalField('rp-name', 'RP name', 'Your roleplay name', TextInputStyle.Short, true, 80),
    modalField('rp-days', 'RP experience in days', 'Enter a whole number', TextInputStyle.Short, true, 5),
    modalField('motivation', 'Why do you want to apply?', 'Specific, professional answer', TextInputStyle.Paragraph, true, 500),
    modalField('scenario', 'How would you handle a tense scene?', 'Explain how you would communicate and follow procedure', TextInputStyle.Paragraph, true, 500),
    modalField('experience', 'Relevant RP experience', 'Summarize your experience', TextInputStyle.Paragraph, true, 500),
  );
  return modal;
}
function offerButton(id) {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`sign-offer:${id}`).setLabel('Review and sign welcome letter').setStyle(ButtonStyle.Success));
}
function newCallsign(department) {
  const prefix = PREFIX[department] ?? 'R';
  const used = new Set([
    ...data.employees.filter(employee => employee.department === department).map(employee => employee.callsign),
    ...data.applications.filter(application => application.department === department && application.status === 'Offer pending signature').map(application => application.callsign),
  ]);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const call = `${prefix}-${String(Math.floor(100 + Math.random() * 900))}`;
    if (!used.has(call)) return call;
  }
  return `${prefix}-${Date.now().toString().slice(-3)}`;
}
function firstRank(department) {
  return (RANKS[department] ?? ['Probationary']).find(rank => /cadet|trainee|probation/i.test(rank)) ?? RANKS[department]?.[0] ?? 'Probationary';
}
function evaluateAnswers(fields, department) {
  const daysText = clean(fields.getTextInputValue('rp-days'));
  const days = Number(daysText);
  const motivation = clean(fields.getTextInputValue('motivation'));
  const scenario = clean(fields.getTextInputValue('scenario'));
  const experience = clean(fields.getTextInputValue('experience'));
  const reasons = [];
  if (!/^\d+$/.test(daysText)) reasons.push('RP experience must be a whole number of days.');
  else if (!NO_EXPERIENCE.has(department) && days < 14) reasons.push('This department requires at least 14 days of RP experience.');
  if (motivation.length < 25 || scenario.length < 25 || experience.length < 8) reasons.push('Please provide complete, specific answers to every interview question.');
  return { days, motivation, scenario, experience, reasons };
}
async function recordInterview(interaction, department, staff = false) {
  const fields = interaction.fields;
  const name = clean(fields.getTextInputValue('rp-name'));
  const answers = evaluateAnswers(fields, staff ? 'Staff' : department);
  const record = { id: `${Date.now()}-${interaction.user.id}`, discordId: interaction.user.id, name, department: staff ? 'Staff' : department, days: answers.days, motivation: answers.motivation, scenario: answers.scenario, experience: answers.experience, createdAt: stamp(), status: '' };
  await interaction.deferReply({ ephemeral: true });
  if (answers.reasons.length) {
    record.status = 'Not qualified';
    record.reason = answers.reasons.join(' ');
    (staff ? data.staff : data.applications).push(record);
    saveData();
    await interaction.editReply({ content: `Sorry, you do not qualify for this position. ${record.reason}` });
    return;
  }
  let aiResult;
  try {
    aiResult = await evaluateInterview({ department: record.department, days: record.days, motivation: record.motivation, scenario: record.scenario, experience: record.experience });
  } catch (error) {
    console.error('Gemini interview evaluation unavailable:', error.message);
    record.aiDecision = 'unavailable';
    record.reason = 'AI evaluation is unavailable; HR review is required.';
    record.status = staff ? 'Awaiting HR review' : 'Pending AI review';
    (staff ? data.staff : data.applications).push(record);
    saveData();
    await interaction.editReply({ content: staff ? 'Your answers meet the experience requirement, but AI evaluation is unavailable. HR will review your staff interview.' : 'Your answers meet the experience requirement, but AI evaluation is unavailable. Your application is pending HR review; you have not been rejected.' });
    return;
  }
  record.aiDecision = aiResult.decision;
  record.aiFeedback = aiResult.feedback;
  record.aiReason = aiResult.reason;
  if (aiResult.decision === 'fail') {
    record.status = 'Not qualified';
    record.reason = aiResult.reason;
    (staff ? data.staff : data.applications).push(record);
    saveData();
    await interaction.editReply({ content: `Sorry, you do not qualify for this position. ${aiResult.feedback}` });
    return;
  }
  if (staff) {
    record.status = 'Awaiting HR review';
    data.staff.push(record);
    saveData();
    await interaction.editReply({ content: `Your staff interview passed the AI review. ${aiResult.feedback} HR must approve staff access before permissions are granted.` });
    return;
  }
  record.callsign = newCallsign(department);
  record.rank = firstRank(department);
  record.status = 'Offer pending signature';
  data.applications.push(record);
  saveData();
  const embed = new EmbedBuilder().setColor(0x38745d).setTitle(`Welcome to ${department}`).setDescription(`Congratulations, ${name}. ${aiResult.feedback}\n\n**Welcome letter**\nYour appointment begins at the probationary level. Your callsign is **${record.callsign}** and your rank is **${record.rank}**. Please check in weekly for promotion review and request a ride-along with an FTO.`).setFooter({ text: 'Sign the welcome letter to accept the appointment and receive your configured department role.' });
  await interaction.editReply({ embeds: [embed], components: [offerButton(record.id)] });
}
async function assignDepartmentRole(interaction, employee) {
  const roleId = deptRoleEnv(employee.department);
  if (!roleId) return 'Department role ID is not configured; HR must assign the role manually.';
  const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
  const rankRoleId = rankRoleEnv(employee.department, employee.rank);
  const rankRole = rankRoleId ? await interaction.guild.roles.fetch(rankRoleId).catch(() => null) : null;
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!role || !member) return 'The configured role or server member could not be found; HR must check the bot configuration.';
  if (!role.editable) return 'The bot cannot manage this role. Move the bot role above the department role.';
  await member.roles.add(role, 'Signed HR welcome letter');
  if (rankRoleId && rankRole?.editable) await member.roles.add(rankRole, 'Signed HR welcome letter');
  else if (rankRoleId) return 'Department role assigned, but the configured rank role could not be assigned; HR must check bot role hierarchy.';
  return 'Your department Discord role has been assigned.';
}
function signatureModal(applicationId) {
  return new ModalBuilder().setCustomId(`signature:${applicationId}`).setTitle('Sign welcome letter').addComponents(modalField('signature', 'Type your full RP name to sign', 'Must match the name on your application', TextInputStyle.Short, true, 80));
}
function clockModal(kind) {
  const modal = new ModalBuilder().setCustomId(`clock:${kind}`).setTitle(kind === 'in' ? 'Clock in' : 'Clock out');
  modal.addComponents(modalField('rp-name', 'RP name', 'Your employee name', TextInputStyle.Short, true, 80), modalField('signature', 'Signature', 'Type your full RP name', TextInputStyle.Short, true, 80));
  if (kind === 'out') modal.addComponents(modalField('note', 'Professional shift note', 'For no incidents: No incidents occurred during this shift.', TextInputStyle.Paragraph, true, 800));
  return modal;
}
function isProfessional(note) {
  const banned = /\b(fuck|fucking|shit|bitch|asshole|idiot|dumbass|lmao|lol)\b/i;
  return note.length >= 18 && !banned.test(note);
}
async function handleEmployeeCommand(interaction) {
  const action = interaction.options.getSubcommand();
  if (action === 'directory') {
    const rows = data.employees.filter(e => e.status !== 'Terminated').slice(0, 25);
    const text = rows.map(e => `**${e.callsign}** · ${e.name} · ${e.department} · ${e.rank}`).join('\n') || 'No employee records yet.';
    await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Employee directory').setDescription(text).setColor(0x1b352c)], ephemeral: true });
    return;
  }
  if (action === 'clock-in' || action === 'clock-out') {
    await interaction.showModal(clockModal(action === 'clock-in' ? 'in' : 'out'));
    return;
  }
  const modal = new ModalBuilder().setCustomId('fto-request').setTitle('FTO ride-along request').addComponents(
    modalField('rp-name', 'RP name', 'Your employee name', TextInputStyle.Short, true, 80),
    modalField('department', 'Department', 'Your department', TextInputStyle.Short, true, 50),
    modalField('availability', 'Availability / note', 'When can you attend?', TextInputStyle.Paragraph, true, 400),
  );
  await interaction.showModal(modal);
}
async function handleStaffCommand(interaction) {
  const action = interaction.options.getSubcommand();
  if (action === 'interview') return interaction.showModal(interviewModal('Staff', true));
  if (!(await isStaff(interaction))) return interaction.reply({ content: 'This FTO portal is restricted to HR and configured staff/FTO roles.', ephemeral: true });
  if (action === 'fto') {
    const body = data.fto.slice(-20).reverse().map(request => `**${request.name}** · ${request.department} · ${request.status}\n${request.availability}`).join('\n\n') || 'No FTO requests yet.';
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('FTO ride-along requests').setDescription(body.slice(0, 4000)).setColor(0x1b352c)], ephemeral: true });
  }
  const user = interaction.options.getUser('member', true);
  const decision = interaction.options.getString('decision', true);
  const request = [...data.fto].reverse().find(item => item.discordId === user.id && item.status === 'Pending');
  if (!request) return interaction.reply({ content: 'No pending FTO request was found for that member.', ephemeral: true });
  request.status = decision === 'approved' ? 'Approved' : 'Denied';
  request.reviewedBy = interaction.user.id;
  request.reviewedAt = stamp();
  saveData();
  return interaction.reply({ content: `FTO request ${request.status.toLowerCase()}.`, ephemeral: true });
}
async function handleHrCommand(interaction) {
  if (!(await isHr(interaction))) return interaction.reply({ content: 'This command is restricted to the configured HR role.', ephemeral: true });
  const action = interaction.options.getSubcommand();
  if (action === 'interviews') {
    const recent = [...data.applications, ...data.staff].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
    const body = recent.map(a => `**${a.name}** · ${a.department} · ${a.days} RP days · ${a.status}${a.reason ? `\n${a.reason}` : ''}`).join('\n\n') || 'No interview records yet.';
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Interview records').setDescription(body).setColor(0x1b352c)], ephemeral: true });
  }
  if (action === 'review') {
    const user = interaction.options.getUser('member', true);
    const application = [...data.applications, ...data.staff].reverse().find(item => item.discordId === user.id);
    if (!application) return interaction.reply({ content: 'No interview record was found for that member.', ephemeral: true });
    const embed = new EmbedBuilder().setTitle(`${application.name} · ${application.department}`).setColor(0x1b352c)
      .addFields(
        { name: 'RP experience', value: `${application.days} days`, inline: true },
        { name: 'Status', value: application.status, inline: true },
        { name: 'Motivation', value: application.motivation || 'Not recorded', inline: false },
        { name: 'Scenario response', value: application.scenario || 'Not recorded', inline: false },
        { name: 'Relevant experience', value: application.experience || 'Not recorded', inline: false },
      );
    if (application.reason) embed.addFields({ name: 'Outcome reason', value: application.reason, inline: false });
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
  if (action === 'records') {
    const open = data.shifts.filter(s => s.type === 'in' && !s.clockedOutAt).length;
    const body = `**Employees:** ${data.employees.length}\n**Shift entries:** ${data.shifts.length}\n**Currently clocked in:** ${open}\n**FTO requests:** ${data.fto.length}\n\n${data.shifts.slice(-8).reverse().map(s => `${s.type === 'in' ? 'Clock in' : 'Clock out'} · ${s.name} · ${displayTime(s.at)}${s.note ? ` · ${s.note}` : ''}`).join('\n') || 'No shift entries yet.'}`;
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Personnel records').setDescription(body.slice(0, 4000)).setColor(0x1b352c)], ephemeral: true });
  }
  if (action === 'fto') {
    const body = data.fto.slice(-20).reverse().map(request => `**${request.name}** · ${request.department} · ${request.status}\n${request.availability}`).join('\n\n') || 'No FTO requests yet.';
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('FTO ride-along requests').setDescription(body.slice(0, 4000)).setColor(0x1b352c)], ephemeral: true });
  }
  if (action === 'staff-decision') {
    const user = interaction.options.getUser('member', true);
    const decision = interaction.options.getString('decision', true);
    const record = [...data.staff].reverse().find(item => item.discordId === user.id && item.status === 'Awaiting HR review');
    if (!record) return interaction.reply({ content: 'No pending staff interview was found for that member.', ephemeral: true });
    record.status = decision === 'approved' ? 'Approved' : 'Denied';
    record.reviewedBy = interaction.user.id;
    record.reviewedAt = stamp();
    if (decision === 'approved' && process.env.STAFF_ROLE_ID) {
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      const role = await interaction.guild.roles.fetch(process.env.STAFF_ROLE_ID).catch(() => null);
      if (member && role?.editable) await member.roles.add(role, 'HR approved staff interview');
      else record.roleNote = 'Staff role could not be assigned; check role ID and bot hierarchy.';
    }
    saveData();
    await user.send(`Your staff interview was ${record.status.toLowerCase()} by HR.${record.roleNote ? ` ${record.roleNote}` : ''}`).catch(() => {});
    return interaction.reply({ content: `Staff application ${record.status.toLowerCase()}.${record.roleNote ? ` ${record.roleNote}` : ''}`, ephemeral: true });
  }
  if (action === 'interview-decision') {
    const user = interaction.options.getUser('member', true);
    const decision = interaction.options.getString('decision', true);
    const application = [...data.applications].reverse().find(item => item.discordId === user.id && (item.status === 'Pending AI review' || (decision === 'approved' && item.status === 'Offer pending signature')));
    if (!application) return interaction.reply({ content: 'No interview awaiting HR review was found for that member.', ephemeral: true });
    if (decision === 'denied') {
      application.status = 'Not qualified';
      application.reason = 'Denied after HR review.';
      application.reviewedBy = interaction.user.id;
      application.reviewedAt = stamp();
      saveData();
      await user.send('Sorry, you do not qualify for this position after HR review.').catch(() => {});
      return interaction.reply({ content: 'Application denied and the applicant was notified when DMs were available.', ephemeral: true });
    }
    if (application.status !== 'Offer pending signature') {
      application.callsign = newCallsign(application.department);
      application.rank = firstRank(application.department);
      application.status = 'Offer pending signature';
      application.reviewedBy = interaction.user.id;
      application.reviewedAt = stamp();
      saveData();
    }
    const embed = new EmbedBuilder().setColor(0x38745d).setTitle(`Welcome to ${application.department}`).setDescription(`HR approved your application.\n\n**Welcome letter**\nYour appointment begins at the probationary level. Your callsign is **${application.callsign}** and your rank is **${application.rank}**. Please check in weekly for promotion review and request a ride-along with an FTO.`).setFooter({ text: 'Sign to accept the appointment and receive your configured department role.' });
    try {
      await user.send({ embeds: [embed], components: [offerButton(application.id)] });
      return interaction.reply({ content: 'Offer sent to the applicant by DM. They must sign it before onboarding.', ephemeral: true });
    } catch {
      return interaction.reply({ content: 'HR approved the application and saved the offer, but the applicant’s DMs are closed. Ask them to enable DMs, then run this approval again to resend the offer.', ephemeral: true });
    }
  }
  const user = interaction.options.getUser('member', true);
  const rank = clean(interaction.options.getString('rank', true));
  const employee = data.employees.find(item => item.discordId === user.id);
  if (!employee) return interaction.reply({ content: 'No employee record is linked to that Discord member.', ephemeral: true });
  if (!(RANKS[employee.department] ?? []).includes(rank)) return interaction.reply({ content: `That rank is not in the ${employee.department} ladder. Valid ranks: ${(RANKS[employee.department] ?? []).join(', ')}`, ephemeral: true });
  const oldRank = employee.rank;
  employee.rank = rank;
  employee.status = 'Active';
  employee.updatedAt = stamp();
  employee.rankHistory ??= [];
  employee.rankHistory.push({ rank, previousRank: oldRank, by: interaction.user.id, at: employee.updatedAt });
  const newRoleId = rankRoleEnv(employee.department, rank);
  let roleMessage = 'Rank updated in the HR record.';
  if (newRoleId) {
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    const role = await interaction.guild.roles.fetch(newRoleId).catch(() => null);
    const oldRoleId = rankRoleEnv(employee.department, oldRank);
    const oldRole = oldRoleId ? await interaction.guild.roles.fetch(oldRoleId).catch(() => null) : null;
    if (member && role?.editable) {
      await member.roles.add(role, 'HR promotion');
      if (oldRole?.editable) await member.roles.remove(oldRole, 'HR promotion');
      roleMessage = 'Rank updated and configured Discord rank role assigned.';
    } else roleMessage = 'Rank updated, but Discord rank role could not be assigned; check role configuration and bot hierarchy.';
  }
  saveData();
  return interaction.reply({ content: `${user} promoted from ${oldRank} to ${rank}. ${roleMessage}`, ephemeral: true });
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', () => console.log(`HR bot online as ${client.user.tag}`));
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'portal') {
        let portalUrl;
        try {
          portalUrl = new URL(process.env.PORTAL_URL || 'https://hr-production-a7ae.up.railway.app');
        } catch {
          return interaction.reply({ content: 'The portal link is not configured. Ask an administrator to set PORTAL_URL.', ephemeral: true });
        }
        if (!['https:', 'http:'].includes(portalUrl.protocol)) return interaction.reply({ content: 'The configured portal link is invalid. Ask an administrator to check PORTAL_URL.', ephemeral: true });
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Open employee and HR portal').setStyle(ButtonStyle.Link).setURL(portalUrl.toString()));
        return interaction.reply({ content: 'Use the portal for employee, staff, and HR tasks.', components: [row], ephemeral: true });
      }
      if (interaction.commandName === 'interview') {
        const department = interaction.options.getString('department', true);
        return interaction.showModal(interviewModal(department));
      }
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('interview:')) return recordInterview(interaction, interaction.customId.split(':')[1]);
      if (interaction.customId === 'staff-interview') return recordInterview(interaction, 'Staff', true);
      if (interaction.customId.startsWith('signature:')) {
        const id = interaction.customId.slice('signature:'.length);
        const application = data.applications.find(item => item.id === id && item.discordId === interaction.user.id && item.status === 'Offer pending signature');
        if (!application) return interaction.reply({ content: 'That offer is no longer available.', ephemeral: true });
        const signature = clean(interaction.fields.getTextInputValue('signature'));
        if (signature.toLowerCase() !== application.name.toLowerCase()) return interaction.reply({ content: 'Signature must match the RP name on your application.', ephemeral: true });
        const employee = { id: application.id, discordId: application.discordId, name: application.name, department: application.department, rank: application.rank, callsign: application.callsign, status: 'Probationary', signature, signedAt: stamp(), rankHistory: [{ rank: application.rank, at: stamp(), by: 'system' }] };
        data.employees.push(employee);
        application.status = 'Accepted';
        application.signedAt = employee.signedAt;
        saveData();
        const roleNote = await assignDepartmentRole(interaction, employee);
        return interaction.reply({ content: `Welcome to ${employee.department}, ${employee.name}. Your callsign is **${employee.callsign}**, your rank is **${employee.rank}**, and your status is **Probationary**. Please request an FTO ride-along and check in weekly for promotion review. ${roleNote}`, ephemeral: true });
      }
      if (interaction.customId.startsWith('clock:')) {
        const kind = interaction.customId.split(':')[1];
        const name = clean(interaction.fields.getTextInputValue('rp-name'));
        const signature = clean(interaction.fields.getTextInputValue('signature'));
        if (signature.toLowerCase() !== name.toLowerCase()) return interaction.reply({ content: 'Signature must match your RP name.', ephemeral: true });
        const employee = data.employees.find(item => item.discordId === interaction.user.id && item.name.toLowerCase() === name.toLowerCase());
        if (!employee) return interaction.reply({ content: 'No employee record matches that Discord member and RP name.', ephemeral: true });
        const openShift = data.shifts.find(item => item.discordId === interaction.user.id && item.type === 'in' && !item.clockedOutAt);
        if (kind === 'in') {
          if (openShift) return interaction.reply({ content: 'You already have an open shift.', ephemeral: true });
          data.shifts.push({ id: `${Date.now()}-${interaction.user.id}`, discordId: interaction.user.id, name, department: employee.department, type: 'in', signature, at: stamp() });
          saveData();
          return interaction.reply({ content: `Clock-in recorded at ${displayTime(data.shifts.at(-1).at)}.`, ephemeral: true });
        }
        if (!openShift) return interaction.reply({ content: 'No open shift was found. Clock in before clocking out.', ephemeral: true });
        const note = clean(interaction.fields.getTextInputValue('note'));
        if (!isProfessional(note)) return interaction.reply({ content: 'Please enter a professional shift note of at least 18 characters. For no incidents, write: “No incidents occurred during this shift.”', ephemeral: true });
        openShift.clockedOutAt = stamp();
        openShift.clockOutSignature = signature;
        openShift.note = note;
        saveData();
        return interaction.reply({ content: `Clock-out recorded at ${displayTime(openShift.clockedOutAt)}.`, ephemeral: true });
      }
      if (interaction.customId === 'fto-request') {
        const name = clean(interaction.fields.getTextInputValue('rp-name'));
        const department = clean(interaction.fields.getTextInputValue('department'));
        const availability = clean(interaction.fields.getTextInputValue('availability'));
        const employee = data.employees.find(item => item.discordId === interaction.user.id && item.name.toLowerCase() === name.toLowerCase());
        if (!employee || employee.department.toLowerCase() !== department.toLowerCase()) return interaction.reply({ content: 'Employee name and department must match your personnel record.', ephemeral: true });
        data.fto.push({ id: `${Date.now()}-${interaction.user.id}`, discordId: interaction.user.id, name, department: employee.department, availability, status: 'Pending', createdAt: stamp() });
        saveData();
        return interaction.reply({ content: 'Your FTO ride-along request was sent to supervisors.', ephemeral: true });
      }
    }
    if (interaction.isButton() && interaction.customId.startsWith('sign-offer:')) {
      const id = interaction.customId.slice('sign-offer:'.length);
      const application = data.applications.find(item => item.id === id && item.discordId === interaction.user.id && item.status === 'Offer pending signature');
      if (!application) return interaction.reply({ content: 'That offer is no longer available.', ephemeral: true });
      return interaction.showModal(signatureModal(id));
    }
  } catch (error) {
    console.error('Interaction failed:', error);
    const message = 'The request could not be completed. Please contact HR.';
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    else await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
  }
});

if (process.argv.includes('--register')) {
  registerCommands().catch(error => {
    console.error(error.message);
    const details = error.rawError?.errors ?? error.rawError;
    if (details) console.error(JSON.stringify(details, null, 2));
    process.exitCode = 1;
  });
} else {
  if (!process.env.DISCORD_TOKEN) {
    console.error('Set DISCORD_TOKEN in .env before starting the bot.');
    process.exitCode = 1;
  } else {
    client.login(process.env.DISCORD_TOKEN);
  }
}
