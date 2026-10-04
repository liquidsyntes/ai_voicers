import pg from 'pg';
import {createHash} from 'node:crypto';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const tables=['Project','Cycle','Reference','ReferenceText','Analysis','Selection','VoiceVersion','Credential','InstructionRevision','Settings','Sample','Proposal','Check','Usage','RuleBatch','VoiceRule','RuleRevision'];
const checkpoint={};
for(const table of tables){
  if(!(await pool.query('SELECT to_regclass($1) AS relation',[`"${table}"`])).rows[0].relation)continue;
  const expression=process.env.CHECKPOINT_FULL==='1'?'to_jsonb(t)':"to_jsonb(t)-'methodVersion'-'rulesRevision'-'sourceRole'-'portrait'";
  const rows=(await pool.query(`SELECT ${expression} AS value FROM "${table}" t ORDER BY COALESCE(to_jsonb(t)->>'id',to_jsonb(t)->>'ownerId')`)).rows;
  checkpoint[table]={count:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
}
console.log(JSON.stringify(checkpoint));await pool.end();
