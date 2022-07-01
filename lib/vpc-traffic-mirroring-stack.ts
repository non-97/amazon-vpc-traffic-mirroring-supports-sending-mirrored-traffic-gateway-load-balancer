import {
  Stack,
  StackProps,
  aws_iam as iam,
  aws_ec2 as ec2,
  aws_elasticloadbalancingv2 as elbv2,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";
import * as fs from "fs";

export class VpcTrafficMirroringStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // IAM Role
    const ssmIamRole = new iam.Role(this, "SSM IAM Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
      ],
    });

    // VPC
    const consumerVPC = new ec2.Vpc(this, "Consumer VPC", {
      cidr: "10.10.0.0/24",
      enableDnsHostnames: true,
      enableDnsSupport: true,
      natGateways: 0,
      maxAzs: 2,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 28 },
        {
          name: "Isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 28,
        },
      ],
    });

    const monitoringVPC = new ec2.Vpc(this, "Monitoring VPC", {
      cidr: "10.10.0.0/24",
      enableDnsHostnames: true,
      enableDnsSupport: true,
      natGateways: 1,
      maxAzs: 2,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 28 },
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
          cidrMask: 28,
        },
      ],
    });

    // Security Group
    const monitoringEC2InstanceSG = new ec2.SecurityGroup(
      this,
      "Monitoring EC2 Instance SG",
      {
        vpc: monitoringVPC,
        description: "",
        allowAllOutbound: true,
      }
    );
    monitoringEC2InstanceSG.addIngressRule(
      ec2.Peer.ipv4(monitoringVPC.vpcCidrBlock),
      ec2.Port.allTraffic()
    );

    // EC2 Instance
    new ec2.Instance(this, "Consumer EC2 Instance", {
      instanceType: new ec2.InstanceType("t3.micro"),
      machineImage: ec2.MachineImage.latestAmazonLinux({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      vpc: consumerVPC,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(8, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      propagateTagsToVolumeOnCreation: true,
      vpcSubnets: consumerVPC.selectSubnets({
        subnetType: ec2.SubnetType.PUBLIC,
      }),
      role: ssmIamRole,
    });

    const monitoringEC2Instance = new ec2.Instance(
      this,
      "Monitoring EC2 Instance",
      {
        instanceType: new ec2.InstanceType("t3.micro"),
        machineImage: ec2.MachineImage.latestAmazonLinux({
          generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
        }),
        vpc: monitoringVPC,
        blockDevices: [
          {
            deviceName: "/dev/xvda",
            volume: ec2.BlockDeviceVolume.ebs(8, {
              volumeType: ec2.EbsDeviceVolumeType.GP3,
            }),
          },
        ],
        propagateTagsToVolumeOnCreation: true,
        vpcSubnets: monitoringVPC.selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
        }),
        securityGroup: monitoringEC2InstanceSG,
        sourceDestCheck: false,
        role: ssmIamRole,
      }
    );

    // Gateway Load Balancer
    const gwlb = new elbv2.CfnLoadBalancer(this, "Gateway Load Balancer", {
      ipAddressType: "ipv4",
      subnets: monitoringVPC.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
      }).subnetIds,
      type: "gateway",
    });

    const gwlbTargetGroup = new elbv2.CfnTargetGroup(
      this,
      "Gateway Load Balancer Target Group",
      {
        healthCheckPort: "22",
        healthCheckProtocol: "TCP",
        port: 6081,
        protocol: "GENEVE",
        targets: [
          {
            id: monitoringEC2Instance.instanceId,
          },
        ],
        targetType: "instance",
        vpcId: monitoringVPC.vpcId,
      }
    );

    new elbv2.CfnListener(this, "Gateway Load Balancer Listener", {
      defaultActions: [
        {
          type: "forward",
          targetGroupArn: gwlbTargetGroup.ref,
        },
      ],
      loadBalancerArn: gwlb.ref,
    });

    // VPC Endpoint service
    const vpcEndpointService = new ec2.CfnVPCEndpointService(
      this,
      "VPC Endpoint Service",
      {
        acceptanceRequired: false,
        gatewayLoadBalancerArns: [gwlb.ref],
      }
    );

    // new ec2.InterfaceVpcEndpoint(this, "VPC Endpoint", {
    //   vpc: consumerVPC,
    //   service: new ec2.InterfaceVpcEndpointService(
    //     `com.amazonaws.vpce.${this.region}.${vpcEndpointService.ref}`,
    //     6081
    //   ),
    //   subnets: consumerVPC.selectSubnets({
    //     subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    //   }),
    // });
  }
}
