import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { QUEUE_NAMES, PAYMENT_JOB_NAMES, PAYMENT_JOB_OPTIONS, type PaymentSimulationJob,type RefundJob } from '@seatrush/shared';
import { logRedisConnectionErrors } from './logger.js';
export function createPaymentQueues(redisUrl:string,logger:Logger,prefix?:string) {
 const connection=new Redis(redisUrl,{connectionName:'seatrush-api-payments',enableOfflineQueue:false,maxRetriesPerRequest:1,connectTimeout:1000,commandTimeout:1000,autoResendUnfulfilledCommands:false});
 logRedisConnectionErrors(connection,logger,'payment redis connection error');
 const options={connection,skipWaitingForReady:true,skipVersionCheck:true,...(prefix===undefined?{}:{prefix})};
 const payments=new Queue(QUEUE_NAMES.paymentEvents,options); const refunds=new Queue(QUEUE_NAMES.refunds,options);
 let unavailable=false;connection.on('ready',()=>{unavailable=false;});
 const warn=(err?:unknown)=>{if(!unavailable){unavailable=true;logger.warn({err},'payment queue unavailable; database sweeps recover');}};
 payments.on('error',warn);refunds.on('error',warn);
 async function enqueue(queue:Queue,name:string,job:PaymentSimulationJob|RefundJob,id:string) {
  if(connection.status!=='ready'){warn();return;}
  try{await queue.add(name,job,{...PAYMENT_JOB_OPTIONS,jobId:id});}catch(err){warn(err);}
 }
 return {enqueuePayment:(job:PaymentSimulationJob)=>enqueue(payments,PAYMENT_JOB_NAMES.simulation,job,job.paymentAttemptId),enqueueRefund:(job:RefundJob)=>enqueue(refunds,PAYMENT_JOB_NAMES.refund,job,job.refundRequiredId),async close(){connection.disconnect();await Promise.all([payments.close(),refunds.close()]);}};
}
